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
function fileTools(cwd: string): ToolDef[] {
  const safe = (p: string) => {
    const abs = path.resolve(cwd, p);
    if (!abs.startsWith(path.resolve(cwd))) throw new Error(`path '${p}' resolves outside the worktree`);
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
        const cmd = String(command ?? '').trim();
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
  ];
}

export class AnthropicProvider implements Provider {
  name = 'anthropic' as const;
  models = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

  async run(model: string, opts: RunOptions, events: RunEvents): Promise<RunResult> {
    const client = await getClient();

    // Tools: caller-provided OR built-in file tools (only if cwd is set).
    const tools: ToolDef[] = opts.tools?.length
      ? opts.tools
      : (opts.cwd && fsSync.existsSync(opts.cwd) ? fileTools(opts.cwd) : []);

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

      const resp = await client.messages.create({
        model,
        max_tokens: 4096,
        system: opts.systemPrompt,
        tools: apiTools.length ? apiTools : undefined,
        messages,
      });

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
