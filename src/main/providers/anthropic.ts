// Anthropic provider — uses the raw Messages API directly so we don't depend
// on the Claude Code CLI subprocess (which crashes on Windows with code 1).
//
// Implements the agent loop in-process: send messages, parse tool_use blocks,
// run our own file tools, feed results back, repeat until we get a text-only
// response or hit maxTurns.

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Provider, RunOptions, RunResult, RunEvents, ToolDef } from './types';
import { validateCommand, audit } from '../runtime';
import { getMcpToolsForWorker } from '../mcp';
import { runBrowserTest } from '../browserTest';
import { remember, recall } from '../memory';

const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

let cachedClient: any = null;
async function getClient() {
  if (cachedClient) return cachedClient;
  const mod = await dynamicImport('@anthropic-ai/sdk');
  const Ctor = mod.default ?? mod.Anthropic;
  cachedClient = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cachedClient;
}

// File tools, scoped to a worktree directory. Anthropic's tool format expects
// JSON Schema for parameters.
function fileTools(cwd: string, agentId: string): ToolDef[] {
  const cwdResolved = path.resolve(cwd);
  const safe = (p: string) => {
    if (typeof p !== 'string' || !p.trim()) throw new Error('path must be a non-empty string');
    // Reject absolute paths upfront so workers can't write to `/repo/foo` (Windows
    // resolves that to `C:\repo\foo`) or to a different drive. Forces relative.
    if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\')) {
      throw new Error(`absolute path not allowed: '${p}'. Use a path relative to your worktree (e.g. 'index.html' or 'src/foo.ts').`);
    }
    const abs = path.resolve(cwdResolved, p);
    // Boundary check needs a trailing separator so wt-1 doesn't match wt-10.
    if (abs !== cwdResolved && !abs.startsWith(cwdResolved + path.sep)) {
      throw new Error(`path '${p}' resolves outside the worktree`);
    }
    return abs;
  };

  return [
    {
      name: 'Read',
      description: 'Read a UTF-8 text file from the worktree. Returns its contents as a string.',
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'relative path inside the worktree' } },
        required: ['path'],
      },
      run: async ({ path: p }) => {
        if (typeof p !== 'string' || !p.trim()) throw new Error('Read needs a non-empty path string');
        return await fs.readFile(safe(p), 'utf8');
      },
    },
    {
      name: 'Write',
      description: 'Write (overwrite) a file in the worktree with UTF-8 content. Creates parent dirs.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'relative path inside the worktree' },
          content: { type: 'string', description: 'full file contents' },
        },
        required: ['path', 'content'],
      },
      run: async ({ path: p, content }) => {
        if (typeof p !== 'string' || !p.trim()) throw new Error('Write needs a non-empty path string');
        if (typeof content !== 'string') throw new Error('Write needs a string content (got ' + typeof content + ')');
        const abs = safe(p);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf8');
        return `wrote ${p} (${content.length} bytes)`;
      },
    },
    {
      name: 'Edit',
      description: 'Replace one occurrence of old_string with new_string in the file. Fails if old_string not found or not unique.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      run: async ({ path: p, old_string, new_string }) => {
        if (typeof p !== 'string' || !p.trim()) throw new Error('Edit needs a non-empty path string');
        if (typeof old_string !== 'string') throw new Error('Edit needs old_string as a string');
        if (typeof new_string !== 'string') throw new Error('Edit needs new_string as a string');
        const abs = safe(p);
        const cur = await fs.readFile(abs, 'utf8');
        if (!cur.includes(old_string)) throw new Error('old_string not found in file');
        const occurrences = cur.split(old_string).length - 1;
        if (occurrences > 1) throw new Error(`old_string appears ${occurrences} times — make it unique`);
        await fs.writeFile(abs, cur.replace(old_string, new_string), 'utf8');
        return `edited ${p}`;
      },
    },
    {
      name: 'Glob',
      description: 'List files in the worktree matching a glob-like pattern (supports * and **). Returns newline-separated relative paths.',
      schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
      run: async ({ pattern }) => {
        const out: string[] = [];
        async function walk(dir: string) {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else out.push(path.relative(cwd, full).replace(/\\/g, '/'));
          }
        }
        try { await walk(cwd); } catch { /* dir empty / missing */ }
        // Convert glob → regex: ** = any, * = no slashes, escape dots
        const rx = new RegExp(
          '^' + pattern
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '§§')
            .replace(/\*/g, '[^/]*')
            .replace(/§§/g, '.*')
          + '$'
        );
        const matches = out.filter(f => rx.test(f));
        return matches.length ? matches.join('\n') : '(no matches)';
      },
    },
    {
      name: 'Run',
      description: 'Run a shell command inside the worktree. Allowed: npm/npx/node/tsc/git read-only/pwd/ls/cat/mkdir/echo. Denied: rm, sudo, curl, ssh, cd, git push, shell composition (;, &&, |), redirection. Timeout 90s. Output capped at 8KB.',
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'shell command to run, e.g. "npm install" or "npx tsc --noEmit"' },
        },
        required: ['command'],
      },
      run: async ({ command }) => {
        let cmd = String(command ?? '').trim();
        // Windows cmd.exe `mkdir` doesn't accept `-p` and treats it as a literal
        // directory name. cmd already creates intermediate dirs without a flag,
        // so strip `-p` on Windows to keep cross-platform agent prompts working.
        if (process.platform === 'win32' && /^mkdir\s+-p\s+/.test(cmd)) {
          cmd = cmd.replace(/^mkdir\s+-p\s+/, 'mkdir ');
        }
        const v = validateCommand(cmd);
        audit({
          ts: Date.now(),
          agent: cwd.split(/[\\/]/).pop() ?? 'unknown',
          tool: 'Run',
          input: { command: cmd.slice(0, 500) },
          decision: v.ok ? 'allow' : 'deny',
          reason: v.reason,
        });
        if (!v.ok) {
          throw new Error(`sandbox denied: ${v.reason}. Use only npm/npx/node/tsc/git-read/safe-builtins. No shell composition or redirection.`);
        }
        return await new Promise<string>((resolve, reject) => {
          // Use shell:true so npm/npx find their .cmd shims on Windows.
          const child = spawn(cmd, { cwd, shell: true, windowsHide: true });
          let out = '';
          let err = '';
          const cap = (s: string, more: string) => (s.length > 8000 ? s : (s + more).slice(0, 8000));
          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 2000);
            reject(new Error('command timed out after 90s'));
          }, 90_000);
          child.stdout.on('data', (b) => { out = cap(out, b.toString()); });
          child.stderr.on('data', (b) => { err = cap(err, b.toString()); });
          child.on('error', (e) => { clearTimeout(timer); reject(e); });
          child.on('close', (code) => {
            clearTimeout(timer);
            const tag = code === 0 ? '[exit 0]' : `[exit ${code}]`;
            const combined = `${tag}\n--- stdout ---\n${out || '(empty)'}\n--- stderr ---\n${err || '(empty)'}`;
            // Successful AND failed runs both return as string so the model can read errors.
            resolve(combined);
          });
        });
      },
    },
    {
      name: 'Fetch',
      description: 'HTTP GET a URL and return the response body (truncated to 32KB). Allowed: docs/code on github, githubusercontent, npmjs.com, mdn-docs, dev.to, stackoverflow, anthropic.com, openai.com docs. Denied: localhost/private IPs/file:// schemes. Use for reading documentation before writing code.',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'absolute https:// URL' },
        },
        required: ['url'],
      },
      run: async ({ url }) => {
        if (typeof url !== 'string') throw new Error('Fetch needs a string url');
        const u = url.trim();
        if (!/^https:\/\//.test(u)) throw new Error('only https:// URLs allowed');
        let parsed: URL;
        try { parsed = new URL(u); } catch { throw new Error('invalid URL'); }
        // Block private network ranges + localhost
        const host = parsed.hostname.toLowerCase();
        if (
          host === 'localhost' ||
          /^127\./.test(host) ||
          /^10\./.test(host) ||
          /^192\.168\./.test(host) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
          host.endsWith('.local') ||
          host === '0.0.0.0'
        ) throw new Error('cannot fetch private/loopback hosts');

        // Domain allowlist — keeps blast radius small. Covers code docs +
        // common research / academic publishers + reputable knowledge sources.
        const allowed = [
          // Code / dev docs
          'github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com',
          'npmjs.com', 'www.npmjs.com', 'registry.npmjs.org',
          'developer.mozilla.org', 'mdn.io',
          'docs.anthropic.com', 'www.anthropic.com',
          'platform.openai.com', 'openai.com',
          'stackoverflow.com', 'dev.to',
          'jsr.io', 'unpkg.com', 'cdn.jsdelivr.net',
          'docs.deno.com', 'nodejs.org',
          'developer.apple.com', 'developer.android.com',
          'docs.expo.dev', 'expo.dev',

          // Research / academic
          'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov',
          'doi.org', 'dx.doi.org',
          'frontiersin.org', 'www.frontiersin.org',
          'sciencedirect.com', 'www.sciencedirect.com',
          'journals.lww.com', 'journals.physiology.org', 'journals.humankinetics.com',
          'biomedcentral.com', 'springeropen.com', 'mdpi.com', 'plos.org',
          'arxiv.org', 'biorxiv.org', 'medrxiv.org',
          'tandfonline.com', 'wiley.com', 'onlinelibrary.wiley.com',
          'nature.com', 'www.nature.com', 'cell.com',
          'bjsm.bmj.com', 'bmj.com',
          'scholar.google.com',
          'researchgate.net', 'www.researchgate.net',
          'europepmc.org', 'www.europepmc.org',
          'sportrxiv.org', 'osf.io',
          'pubs.aaai.org', 'acsm.org', 'journals.sagepub.com',

          // Reference / knowledge
          'en.wikipedia.org', 'wikipedia.org',
        ];
        if (!allowed.some(d => host === d || host.endsWith('.' + d))) {
          throw new Error(`domain '${host}' not in allowlist. Allowed: ${allowed.slice(0, 6).join(', ')}, ...`);
        }

        audit({
          ts: Date.now(),
          agent: cwd.split(/[\\/]/).pop() ?? 'unknown',
          tool: 'Fetch',
          input: { url: u },
          decision: 'allow',
        });

        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 15_000);
        try {
          const resp = await fetch(u, { signal: ctrl.signal, redirect: 'follow' });
          const text = await resp.text();
          const status = resp.status;
          const truncated = text.slice(0, 32_000);
          const note = text.length > 32_000 ? `\n[truncated from ${text.length} bytes]` : '';
          return `[HTTP ${status}]\n${truncated}${note}`;
        } finally {
          clearTimeout(timeout);
        }
      },
    },
    {
      name: 'Grep',
      description: 'Search for a regex pattern across files in the worktree. Returns file:line:match for each hit, capped at 50 hits.',
      schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'regex to search for' },
          glob: { type: 'string', description: 'optional file glob (e.g. "*.ts")' },
        },
        required: ['pattern'],
      },
      run: async ({ pattern, glob }) => {
        const rx = new RegExp(pattern);
        const fileRx = glob
          ? new RegExp('^' + glob.replace(/\./g, '\\.').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$')
          : null;
        const out: string[] = [];
        async function walk(dir: string) {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else {
              const rel = path.relative(cwd, full).replace(/\\/g, '/');
              if (fileRx && !fileRx.test(rel)) continue;
              try {
                const content = await fs.readFile(full, 'utf8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length && out.length < 50; i++) {
                  if (rx.test(lines[i])) out.push(`${rel}:${i + 1}:${lines[i].slice(0, 200)}`);
                }
              } catch { /* binary or unreadable, skip */ }
            }
            if (out.length >= 50) return;
          }
        }
        try { await walk(cwd); } catch { /* empty */ }
        return out.length ? out.join('\n') : '(no matches)';
      },
    },
    {
      name: 'Remember',
      description: 'Save a note to long-term memory so future workers (and your future self) can recall it. Use AFTER finishing a piece of work to capture: what you built, where (file paths), what worked, what didn\'t, surprising design decisions. Pass `tag` to label the note (e.g. "decision", "bug", "api-shape"). Use `shared:true` to make the note visible to all workers, otherwise it\'s scoped to you.',
      schema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'the note to remember (1-2 paragraphs ideal)' },
          tag: { type: 'string', description: 'optional short label, e.g. "decision", "bug", "auth"' },
          shared: { type: 'boolean', description: 'if true, all workers can recall this note. Default false (private).' },
        },
        required: ['content'],
      },
      run: async ({ content, tag, shared }) => {
        if (typeof content !== 'string' || !content.trim()) throw new Error('Remember needs non-empty content');
        const owner = shared ? 'shared' : agentId;
        const id = await remember(owner, content, typeof tag === 'string' ? tag : undefined);
        return `saved chunk #${id ?? '?'} (${owner}${tag ? `, tag=${tag}` : ''})`;
      },
    },
    {
      name: 'Recall',
      description: 'Search long-term memory by semantic similarity. Returns the top-K most relevant chunks (your own + shared). Use BEFORE starting work to discover prior decisions, related code, or known bugs in the area you\'re touching. Query is a natural-language description of what you\'re looking for, not keywords.',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'natural-language description of what you want to recall' },
          limit: { type: 'number', description: 'max chunks to return (default 5, max 20)' },
        },
        required: ['query'],
      },
      run: async ({ query, limit }) => {
        if (typeof query !== 'string' || !query.trim()) throw new Error('Recall needs a query');
        const results = await recall(agentId, query, typeof limit === 'number' ? limit : 5);
        if (results.length === 0) return '(no memory yet — call Remember to save notes)';
        return results.map((r, i) => `[${i + 1}] (score=${r.score.toFixed(3)}${r.tag ? `, tag=${r.tag}` : ''})\n${r.content}`).join('\n\n');
      },
    },
    {
      name: 'BrowserTest',
      description: 'Load an HTML file in a hidden Chromium window, optionally run a JS assertion in page context, and save a PNG screenshot to the worktree. Use AFTER writing UI to verify it actually works before reporting done. The assertion runs as the body of an async function — return truthy to pass, falsy or throw to fail. Examples: `return document.title === "Hello"` or `return document.querySelectorAll(".card").length === 4`. Returns PASS/FAIL plus screenshot filename plus first 5 console messages.',
      schema: {
        type: 'object',
        properties: {
          htmlPath: { type: 'string', description: 'relative path to .html file in your worktree, e.g. "index.html"' },
          assertion: { type: 'string', description: 'optional JS body that must return truthy on success. Runs in page context. Has access to document, window, etc.' },
        },
        required: ['htmlPath'],
      },
      run: async ({ htmlPath, assertion }) => {
        if (typeof htmlPath !== 'string' || !htmlPath.trim()) throw new Error('BrowserTest needs htmlPath');
        const abs = safe(htmlPath);
        try {
          await fs.access(abs);
        } catch {
          throw new Error(`htmlPath not found: ${htmlPath}`);
        }
        // v1.0.1 — write screenshots OUTSIDE the worker's worktree so they
        // don't pollute git status and confuse Reviewer ("worker delivered a
        // PNG instead of the HTML"). Mirror the worker dir name into a
        // sibling ".hive-screenshots/" so we still get per-worker scoping.
        const screenshotName = `test_${Date.now()}.png`;
        const workerDirName = path.basename(cwdResolved); // e.g. "wt-1"
        const shotsDir = path.join(cwdResolved, '..', '.hive-screenshots', workerDirName);
        const screenshotAbs = path.join(shotsDir, screenshotName);
        await fs.mkdir(shotsDir, { recursive: true });
        const result = await runBrowserTest({
          htmlPathAbs: abs,
          assertion: typeof assertion === 'string' ? assertion : undefined,
          screenshotPathAbs: screenshotAbs,
        });
        const logs = result.consoleLogs.slice(0, 5);
        const logBlock = logs.length ? `\n--- console (first ${logs.length}) ---\n${logs.join('\n')}` : '';
        // Cite a shareable label only — workers can't open PNGs anyway, and we
        // don't want them tempted to read it as a deliverable.
        if (result.ok) {
          return `PASS\nscreenshot saved (worker test artifact, outside worktree)${logBlock}`;
        }
        return `FAIL — ${result.error}\nscreenshot: (none)${logBlock}`;
      },
    },
  ];
}

export class AnthropicProvider implements Provider {
  name = 'anthropic' as const;
  models = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

  async run(model: string, opts: RunOptions, events: RunEvents): Promise<RunResult> {
    if (!opts.prompt || !opts.prompt.trim()) {
      throw new Error('cannot run with empty prompt — caller dispatched a blank task');
    }
    const client = await getClient();

    // Tools: caller-provided OR built-in file tools (only if cwd is set),
    // augmented with any MCP-server tools currently connected.
    // Manager passes noTools:true so it doesn't waste its single turn on tools.
    const agentId = (events as any)._agentId ?? 'unknown';
    const baseTools: ToolDef[] = opts.tools?.length
      ? opts.tools
      : (opts.cwd && fsSync.existsSync(opts.cwd) ? fileTools(opts.cwd, agentId) : []);
    const mcpTools = opts.noTools ? [] : getMcpToolsForWorker();
    const tools: ToolDef[] = opts.noTools ? [] : [...baseTools, ...mcpTools];

    const apiTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }));

    const messages: any[] = [{ role: 'user', content: opts.prompt }];
    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;
    let finalText = '';
    const maxTurns = opts.maxTurns ?? 8;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (opts.abortSignal?.aborted) throw new Error('cancelled');
      turns++;

      // Anthropic API call with exponential backoff on 429s.
      let resp: any = null;
      let lastErr: any = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          // Send the system prompt as a content block with ephemeral cache_control
          // so subsequent turns in this run hit the prompt cache (50% read cost,
          // ~5min TTL). Tools array is also stable across turns — same benefit.
          resp = await client.messages.create({
            model,
            max_tokens: 4096,
            system: opts.systemPrompt
              ? [{ type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } }]
              : undefined,
            tools: apiTools.length
              ? apiTools.map((t, i) => i === apiTools.length - 1
                  ? { ...t, cache_control: { type: 'ephemeral' } }
                  : t)
              : undefined,
            messages,
          });
          break;
        } catch (err: any) {
          lastErr = err;
          const status = err?.status ?? err?.response?.status;
          const isRateLimit = status === 429 || /rate.?limit/i.test(String(err?.message ?? ''));
          if (!isRateLimit || attempt === 4) throw err;
          // Honour Retry-After when present, else backoff: 4s, 8s, 16s, 32s
          const retryAfterHeader = err?.headers?.['retry-after'] ?? err?.response?.headers?.['retry-after'];
          const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : null;
          const backoff = retryAfter ?? Math.min(60_000, 4_000 * Math.pow(2, attempt)) + Math.random() * 1_000;
          events.onError?.(new Error(`rate-limited (attempt ${attempt + 1}/5), backing off ${Math.round(backoff / 1000)}s`));
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, backoff);
            opts.abortSignal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
          });
        }
      }
      if (!resp) throw lastErr ?? new Error('no response');

      const turnIn = resp.usage?.input_tokens ?? 0;
      const turnOut = resp.usage?.output_tokens ?? 0;
      inputTokens += turnIn;
      outputTokens += turnOut;
      (events as any)._tokenDelta?.(turnIn + turnOut);

      // Push assistant turn into history.
      messages.push({ role: 'assistant', content: resp.content });

      const toolUses = resp.content.filter((b: any) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // No tool call → final answer.
        const textBlocks = resp.content.filter((b: any) => b.type === 'text');
        finalText = textBlocks.map((b: any) => b.text).join('\n');
        events.onText?.(finalText);
        break;
      }

      // Run each tool, collect results, push back as user turn.
      const results: any[] = [];
      for (const use of toolUses) {
        events.onToolCall?.(use.name, use.input);
        const tool = tools.find(t => t.name === use.name);
        let result: string;
        let isError = false;
        if (!tool) {
          result = `unknown tool: ${use.name}`;
          isError = true;
        } else {
          try {
            result = await tool.run(use.input);
            events.onToolResult?.(use.name, result.slice(0, 200));
          } catch (e: any) {
            result = `error: ${e.message ?? e}`;
            isError = true;
            events.onError?.(e);
          }
        }
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: result.slice(0, 8000),
          is_error: isError,
        });
      }
      messages.push({ role: 'user', content: results });
    }

    return { text: finalText.trim(), inputTokens, outputTokens, turns };
  }
}
