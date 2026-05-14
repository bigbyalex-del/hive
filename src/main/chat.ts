// Programme Lead chat — tool-using conversational chat that's distinct
// from the citation-checked consultAdvisor pipeline. Reuses persona
// system-prompts but enables a small set of READ-ONLY tools so the
// Programme Lead (or any persona) can answer with live data:
//   - fxv_read: read a file from the FXV repo
//   - fxv_grep: search FXV repo for a pattern
//   - web_fetch: GET a URL (allowlist + fxvperformance.com)
//   - hive_actions: list current open Actions
//
// Provider/model are picked per message by the renderer; defaults to
// Anthropic Sonnet. No writes — direction-setting only.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ToolDef, ProviderName, RunOptions } from './providers/types';
import { getProvider, listProviders } from './providers/registry';
import { loadPersonas } from './advisors';
import { listActions, updateAction, deleteAction, getAction } from './db';

const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
const GENERATED_IMAGES_DIR = path.join(os.homedir(), '.hive', 'generated-images');

// ── Image generation providers ────────────────────────────────────
// All return base64 PNG. Each requires a different env var; absence
// throws a clear error so the persona can tell the user what to set.

async function generateOpenAI(prompt: string, size: string, quality: 'standard' | 'high'): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing — needed for gpt-image-1');
  const mod = await dynamicImport('openai');
  const Ctor = mod.default ?? mod.OpenAI;
  const client = new Ctor({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.images.generate({
    model: 'gpt-image-1',
    prompt: prompt.slice(0, 4000),
    size,
    quality,
    n: 1,
  });
  const b64 = resp?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  return b64;
}

async function generateFluxPro(prompt: string, size: string): Promise<string> {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY missing — add to .env to use flux-pro. Get one at fal.ai/dashboard/keys');
  // fal.ai uses image_size enums; map our sizes to theirs
  const fluxSize = size === '1536x1024' ? 'landscape_4_3'
    : size === '1024x1536' ? 'portrait_4_3'
    : 'square_hd';
  // Synchronous "run" endpoint — blocks until generation finishes
  const resp = await fetch('https://fal.run/fal-ai/flux-pro/v1.1', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${process.env.FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: prompt.slice(0, 4000),
      image_size: fluxSize,
      num_images: 1,
      enable_safety_checker: true,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`fal.ai flux-pro: HTTP ${resp.status} ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const imgUrl = data?.images?.[0]?.url;
  if (!imgUrl) throw new Error('fal.ai returned no image URL');
  // Fetch the image bytes and convert to base64
  const imgResp = await fetch(imgUrl);
  if (!imgResp.ok) throw new Error(`flux-pro image fetch failed: HTTP ${imgResp.status}`);
  const buf = Buffer.from(await imgResp.arrayBuffer());
  return buf.toString('base64');
}

async function generateImagen(prompt: string, size: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY missing — add to .env to use imagen-3. Get one at aistudio.google.com');
  // Google Imagen aspect-ratio enum mapping
  const aspect = size === '1536x1024' ? '4:3'
    : size === '1024x1536' ? '3:4'
    : '1:1';
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt: prompt.slice(0, 4000) }],
        parameters: { sampleCount: 1, aspectRatio: aspect, personGeneration: 'allow_adult' },
      }),
    },
  );
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Imagen: HTTP ${resp.status} ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('Imagen returned no image');
  return b64;
}

const FXV_ROOT = 'C:\\Users\\Fusion\\.openclaw\\workspace\\fxv-performance';
const FXV_ALLOWED_SUBDIRS = ['mobile', 'supabase', 'site', 'docs'];

function safeFxvPath(rel: string): string {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('path required');
  if (path.isAbsolute(rel) || rel.includes('..')) throw new Error('relative path only (no .. or absolute)');
  const abs = path.resolve(FXV_ROOT, rel);
  if (abs !== FXV_ROOT && !abs.startsWith(FXV_ROOT + path.sep)) {
    throw new Error('path escapes FXV root');
  }
  // Restrict to allowed subdirs (mobile/, supabase/, site/, docs/) plus root-level files
  const relFromRoot = path.relative(FXV_ROOT, abs);
  const firstSeg = relFromRoot.split(/[\\/]/)[0];
  if (firstSeg && !FXV_ALLOWED_SUBDIRS.includes(firstSeg) && !/\.(md|json|txt)$/i.test(firstSeg)) {
    throw new Error(`only ${FXV_ALLOWED_SUBDIRS.join('/')}/ subdirs or root-level *.md/*.json allowed`);
  }
  return abs;
}

const WEB_ALLOWLIST = [
  'fxvperformance.com', 'www.fxvperformance.com',
  'github.com', 'raw.githubusercontent.com',
  'docs.anthropic.com', 'www.anthropic.com',
  'platform.openai.com', 'openai.com',
  'developer.apple.com', 'docs.expo.dev',
  'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov',
  'doi.org', 'frontiersin.org',
  'en.wikipedia.org', 'wikipedia.org',
];

function chatTools(): ToolDef[] {
  return [
    {
      name: 'fxv_read',
      description: 'Read a UTF-8 text file from the FXV repo. Use this to inspect current source / migrations / docs before answering. Paths are relative to repo root (e.g. "mobile/src/screens/aerobic/AerobicSetup.tsx" or "supabase/functions/generate-programme/index.ts").',
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'relative path inside fxv-performance repo' } },
        required: ['path'],
      },
      run: async ({ path: p }) => {
        const abs = safeFxvPath(p);
        const content = await fs.readFile(abs, 'utf8');
        return content.length > 60_000 ? content.slice(0, 60_000) + `\n…(truncated, file is ${content.length} bytes)` : content;
      },
    },
    {
      name: 'fxv_grep',
      description: 'Search the FXV repo for a regex pattern. Returns file:line:match for up to 50 hits. Optional `glob` (e.g. "*.ts") filters by file extension.',
      schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'regex pattern (JS RegExp syntax)' },
          glob: { type: 'string', description: 'optional file extension filter, e.g. "*.ts"' },
        },
        required: ['pattern'],
      },
      run: async ({ pattern, glob }) => {
        const rx = new RegExp(pattern);
        const ext = typeof glob === 'string' && /\*\.\w+$/.test(glob) ? glob.slice(1) : null;
        const out: string[] = [];
        const SKIP = new Set(['node_modules', '.git', '.expo', 'ios', 'android', 'dist', 'build', 'web-stubs', '__tests__']);
        async function walk(dir: string) {
          if (out.length >= 50) return;
          let entries;
          try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (out.length >= 50) return;
            if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else {
              if (ext && !e.name.endsWith(ext)) continue;
              if (!/\.(ts|tsx|js|jsx|json|md|sql)$/i.test(e.name)) continue;
              try {
                const content = await fs.readFile(full, 'utf8');
                const lines = content.split('\n');
                const rel = path.relative(FXV_ROOT, full).replace(/\\/g, '/');
                for (let i = 0; i < lines.length && out.length < 50; i++) {
                  if (rx.test(lines[i])) out.push(`${rel}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
                }
              } catch {}
            }
          }
        }
        for (const sub of FXV_ALLOWED_SUBDIRS) {
          await walk(path.join(FXV_ROOT, sub));
          if (out.length >= 50) break;
        }
        return out.length ? out.join('\n') : '(no matches)';
      },
    },
    {
      name: 'web_fetch',
      description: 'HTTP GET a URL and return the response body (text, capped at 32KB). Allowlisted to fxvperformance.com, GitHub, anthropic/openai docs, PubMed, MDN/Wikipedia. Use for verifying public-facing content (e.g. methodology page) or reading docs.',
      schema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'absolute https:// URL' } },
        required: ['url'],
      },
      run: async ({ url }) => {
        if (typeof url !== 'string') throw new Error('url required');
        const u = url.trim();
        if (!/^https:\/\//.test(u)) throw new Error('only https:// allowed');
        let parsed: URL;
        try { parsed = new URL(u); } catch { throw new Error('invalid URL'); }
        const host = parsed.hostname.toLowerCase();
        // Block private/local
        if (host === 'localhost' || /^127\./.test(host) || /^10\./.test(host)
            || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
            || host.endsWith('.local') || host === '0.0.0.0') {
          throw new Error('cannot fetch private/loopback hosts');
        }
        if (!WEB_ALLOWLIST.some(d => host === d || host.endsWith('.' + d))) {
          throw new Error(`domain '${host}' not in allowlist`);
        }
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 15_000);
        try {
          const resp = await fetch(u, { signal: ctrl.signal, redirect: 'follow' });
          const text = await resp.text();
          const truncated = text.slice(0, 32_000);
          const note = text.length > 32_000 ? `\n[truncated from ${text.length} bytes]` : '';
          return `[HTTP ${resp.status}]\n${truncated}${note}`;
        } finally {
          clearTimeout(timeout);
        }
      },
    },
    {
      name: 'generate_image',
      description: `Generate an image and save it to ~/.hive/generated-images/. Returns the saved path. Pick the model based on the job:
- gpt-image-1 (default): OpenAI's DALL-E successor. Best for text rendering inside images, prompt adherence, instructional/promotional. ~£0.03 std, £0.13 HD.
- flux-pro: Black Forest Labs Flux 1.1 Pro via fal.ai. Best for raw aesthetic quality, athletic / cinematic photography. ~£0.04. Needs FAL_KEY.
- imagen-3: Google Imagen 3. Best photorealism (people, action shots). ~£0.04. Needs GOOGLE_API_KEY.

Always ask the user before generating — don't use speculatively.`,
      schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'detailed description (style, composition, colours, mood). gpt-image-1 follows prompts most literally; flux/imagen reward more descriptive language.' },
          model: { type: 'string', enum: ['gpt-image-1', 'flux-pro', 'imagen-3'], description: 'which image model to use. Default gpt-image-1.' },
          size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'], description: 'aspect: square / landscape / portrait. Default 1024x1024.' },
          quality: { type: 'string', enum: ['standard', 'high'], description: 'standard or high (gpt-image-1 only). Default standard.' },
          filename: { type: 'string', description: 'optional descriptive filename (no extension, no slashes).' },
        },
        required: ['prompt'],
      },
      run: async ({ prompt, model, size, quality, filename }) => {
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt required');
        const requestSize = ['1024x1024', '1536x1024', '1024x1536'].includes(size) ? size : '1024x1024';
        const chosen = ['gpt-image-1', 'flux-pro', 'imagen-3'].includes(model) ? model : 'gpt-image-1';
        const safeName = (typeof filename === 'string' && filename.trim())
          ? filename.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)
          : `img-${chosen}-${Date.now()}`;
        let b64: string;
        if (chosen === 'gpt-image-1') {
          b64 = await generateOpenAI(prompt, requestSize, quality === 'high' ? 'high' : 'standard');
        } else if (chosen === 'flux-pro') {
          b64 = await generateFluxPro(prompt, requestSize);
        } else {
          b64 = await generateImagen(prompt, requestSize);
        }
        await fs.mkdir(GENERATED_IMAGES_DIR, { recursive: true });
        const filePath = path.join(GENERATED_IMAGES_DIR, `${safeName}.png`);
        await fs.writeFile(filePath, Buffer.from(b64, 'base64'));
        const sizeBytes = Buffer.byteLength(b64, 'base64');
        return `Saved: ${filePath}\nModel: ${chosen}\nSize: ${requestSize}\nFile size: ${(sizeBytes / 1024).toFixed(0)} KB`;
      },
    },
    {
      name: 'hive_actions',
      description: 'List currently OPEN Actions tracked in Hive (todo/in_progress/in_review/blocked). Returns id, persona, status, priority, content. Use to answer "what is in-flight right now" without you having to retype the list.',
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'todo', 'in_progress', 'done', 'all'], description: 'default: active' },
          limit: { type: 'number', description: 'max rows (default 50, hard cap 200)' },
        },
      },
      run: async ({ status, limit }) => {
        const rows = listActions({
          status: (status as any) ?? 'active',
          limit: typeof limit === 'number' ? Math.min(200, Math.max(1, limit)) : 50,
        });
        if (!rows.length) return '(no matching actions)';
        return rows.map(r =>
          `#${r.id} [${r.status}/${r.priority ?? 'med'}] ${r.personaId ?? '?'} — ${r.content.slice(0, 200)}`
        ).join('\n');
      },
    },
    {
      name: 'hive_action_update_status',
      description: 'Update the status of a Hive Action by id. Use this to mark an action done (when it no longer reflects open work) or cancelled (when it\'s no longer relevant). Quote the id from hive_actions. Always state which actions you\'re changing and why in your reply.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'action id from hive_actions' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'], description: 'new status' },
        },
        required: ['id', 'status'],
      },
      run: async ({ id, status }) => {
        if (typeof id !== 'number') throw new Error('id must be a number');
        const cur = getAction(id);
        if (!cur) throw new Error(`action #${id} not found`);
        const prev = cur.status;
        updateAction(id, { status: status as any });
        return `Updated #${id}: ${prev} → ${status}. Content: "${cur.content.slice(0, 120)}"`;
      },
    },
    {
      name: 'hive_action_delete',
      description: 'Permanently delete a Hive Action by id. Use ONLY when an action is genuinely irrelevant or a duplicate — prefer marking cancelled when in doubt (undoable, delete is not). Quote the id from hive_actions. Always state which actions you\'re deleting and why in your reply.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'action id from hive_actions' },
        },
        required: ['id'],
      },
      run: async ({ id }) => {
        if (typeof id !== 'number') throw new Error('id must be a number');
        const cur = getAction(id);
        if (!cur) throw new Error(`action #${id} not found`);
        deleteAction(id);
        return `Deleted #${id}. Was: [${cur.status}] "${cur.content.slice(0, 120)}"`;
      },
    },
  ];
}

export interface ChatRequest {
  personaId: string;
  question: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  providerName?: ProviderName;
  model?: string;
  enableTools?: boolean;
}

export interface ChatResult {
  reply: string;
  personaId: string;
  personaName: string;
  provider: string;
  model: string;
  toolCalls: { name: string; input: any; resultPreview: string }[];
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export function listChatModels(): { providers: { name: ProviderName; models: string[] }[] } {
  return { providers: listProviders() };
}

export async function chatWithAdvisor(req: ChatRequest): Promise<ChatResult> {
  const personas = loadPersonas();
  const persona = personas.personas.find(p => p.id === req.personaId);
  if (!persona) throw new Error(`unknown persona: ${req.personaId}`);

  const providerName: ProviderName = req.providerName ?? 'anthropic';
  const provider = getProvider(providerName);
  const model = req.model && provider.models.includes(req.model)
    ? req.model
    : provider.models[0];

  const systemPrompt = `You are ${persona.name}, ${persona.title}.
Your scope: ${persona.scope}

You are in a live conversation with the user. You have access to tools:

Read-only:
- fxv_read: read a file from the FXV codebase
- fxv_grep: grep for a pattern in the FXV codebase
- web_fetch: GET a URL (fxvperformance.com, GitHub, docs, PubMed)
- hive_actions: list open Actions in Hive

Image generation (asks user first):
- generate_image: produce a PNG via OpenAI / Flux / Imagen. Saves to ~/.hive/generated-images/.

Action management (use carefully):
- hive_action_update_status: change an action's status (todo, in_progress, done, cancelled, etc.)
- hive_action_delete: permanently remove an action

Use tools when answering would benefit from live data. Don't tool-call gratuitously. When changing or deleting Actions, ALWAYS state which ones you're touching and why so the user can see the reasoning before/while you act. Prefer "cancelled" over delete when in doubt — delete is not undoable. Cite tool outputs by file path / URL / action id. Keep replies conversational and concise (3–6 sentences unless the user asks for depth). If you don't have grounded info, say so plainly — don't guess.`;

  const tools: ToolDef[] = req.enableTools !== false ? chatTools() : [];

  const history = req.history ?? [];
  const prompt = history.length === 0
    ? req.question
    : history.map(m => `${m.role === 'user' ? 'USER' : 'YOU'}: ${m.content}`).join('\n\n') + `\n\nUSER: ${req.question}`;

  const toolCalls: ChatResult['toolCalls'] = [];

  const runOpts: RunOptions = {
    systemPrompt,
    prompt,
    tools,
    maxTurns: 8,
  };

  const result = await provider.run(model, runOpts, {
    onToolCall: (name, input) => { toolCalls.push({ name, input, resultPreview: '' }); },
    onToolResult: (name, result) => {
      const slot = toolCalls.slice().reverse().find(t => t.name === name && !t.resultPreview);
      if (slot) slot.resultPreview = result.slice(0, 200);
    },
  });

  return {
    reply: result.text,
    personaId: persona.id,
    personaName: persona.name,
    provider: providerName,
    model,
    toolCalls,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    turns: result.turns,
  };
}
