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
import { ToolDef, ProviderName, RunOptions } from './providers/types';
import { getProvider, listProviders } from './providers/registry';
import { loadPersonas } from './advisors';
import { listActions } from './db';

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

You are in a live conversation with the user. You have access to read-only tools:
- fxv_read: read a file from the FXV codebase
- fxv_grep: grep for a pattern in the FXV codebase
- web_fetch: GET a URL (fxvperformance.com, GitHub, docs)
- hive_actions: list open Actions in Hive

Use tools when answering would benefit from live data. Don't tool-call gratuitously — only when the question can't be answered without it. Cite tool outputs by file path or URL. Keep replies conversational and concise (3–6 sentences unless the user asks for depth). If you don't have grounded info, say so plainly — don't guess.`;

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
