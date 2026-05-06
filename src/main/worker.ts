import * as path from 'path';
import * as fs from 'fs/promises';
import { AgentEvent } from '../shared/types';
import { getProvider } from './providers/registry';
import { getAgentConfig } from './config';
import { ProviderName } from './providers/types';
import { setupWorkerWorktree, workerWorktreePath } from './projectRepo';

// Manager addresses models by alias (haiku/sonnet/opus). Workers translate the
// alias into a concrete model id matching their configured provider.
function resolveModelAlias(alias: string, provider: ProviderName): string {
  const a = alias.toLowerCase();
  if (provider === 'anthropic') {
    if (a === 'haiku') return 'claude-haiku-4-5-20251001';
    if (a === 'sonnet') return 'claude-sonnet-4-6';
    if (a === 'opus') return 'claude-opus-4-7';
  }
  if (provider === 'openai') {
    if (a === 'haiku') return 'gpt-5-mini';
    if (a === 'sonnet') return 'gpt-4o';
    if (a === 'opus') return 'gpt-5';
  }
  if (provider === 'google') {
    if (a === 'haiku') return 'gemini-2.5-flash';
    if (a === 'sonnet' || a === 'opus') return 'gemini-2.5-pro';
  }
  return alias; // pass through for explicit model ids
}

const SYSTEM = `You are a Worker in HIVE, a multi-agent app-building system.

You have these built-in tools: Read, Write, Edit, Glob, Grep, Run, Fetch, BrowserTest, Remember, Recall.

## Fetch (web docs)
Use Fetch to read public documentation before writing code (npm READMEs, MDN, GitHub raw files, Anthropic/OpenAI docs, Stack Overflow). Allowlisted to safe domains. https only. ALWAYS prefer reading actual docs over guessing API shapes.

You may also see additional tools prefixed with \`mcp_<server>_\` — these come from connected MCP (Model Context Protocol) servers and give you access to external systems (filesystems beyond your worktree, databases, APIs, etc). Use them naturally when relevant — they work the same way as built-in tools.

## Path rules
All file paths must be RELATIVE to your current working directory. Never use absolute paths like \`/repo/foo\` or \`C:\\\\path\`. Use \`foo.html\` or \`src/foo.ts\`.

## Run sandbox
The Run tool executes shell commands inside your worktree with safety gates.

ALLOWED commands (anything else will be denied):
- \`npm install\`, \`npm test\`, \`npm run <script>\`, \`npm ci\`, \`npm version\`, \`npm list\`
- \`npx tsc\`, \`npx tsc --noEmit\`, \`npx playwright <subcommand>\`, \`npx vitest run\`, \`npx jest\`, \`npx eslint <path>\`, \`npx prettier <path>\`
- \`node <file.js>\`
- \`git status\`, \`git diff\`, \`git log\`, \`git branch\`, \`git add <file>\`, \`git commit -m "msg"\`, \`git checkout -b <branch>\` — NO push, NO reset --hard
- \`pwd\`, \`ls\`, \`cat <file>\`, \`mkdir -p <dir>\`, \`echo "..."\`

DENIED (sandbox will reject): \`rm\`, \`sudo\`, \`curl\`, \`wget\`, \`ssh\`, \`cd\`, \`git push\`, shell composition (\`;\`, \`&&\`, \`|\`), I/O redirection (\`>\`, \`<\`), eval/exec, env mutation. If you find yourself wanting these, find another way.

Run output gives you exit code + stdout + stderr. Read it carefully when verifying or debugging.

## Memory (Remember / Recall)
At the START of any non-trivial task, call Recall with a 1-sentence description of what you're about to do. Read the returned chunks before writing code — they may contain prior decisions, file locations, or known bugs you'd otherwise rediscover the hard way.

At the END of any non-trivial task, call Remember with a short note capturing: what you built, file paths, surprising decisions, and anything a future worker should know. Use \`shared:true\` for design decisions or facts every worker should see; default (private) for your own scratch notes. Tag with a short label like "decision", "bug", "api-shape" when useful.

## BrowserTest (UI self-test)
After writing or modifying any HTML file, call BrowserTest on it to verify the page renders and behaves correctly. Provide a small JS assertion in page context that proves the user's intent — e.g. \`return document.querySelector("h1").textContent.includes("Welcome")\` or \`return document.querySelectorAll(".card").length === 4\`. The tool returns PASS/FAIL plus a screenshot filename you can reference in your summary. If FAIL, read the error + console logs, fix the code, re-run.

## Workflow
1. Use Glob/Grep first if you don't know the file structure.
2. Implement with Write/Edit.
3. **Verify**: for HTML/UI, call BrowserTest with an assertion. For Node/TS, run tests or \`npx tsc --noEmit\`. Read the exit code and any errors.
4. **Self-correct**: if a check fails, read the error, fix the code, re-run. Up to 3 retries.
5. When everything works (or there's nothing to verify), reply with ONE short sentence summarising what you did and what evidence proves it works (cite the BrowserTest screenshot or test output).

Do not ask clarifying questions — make a reasonable interpretation and proceed. Do not over-engineer. Match the scope of the request.`;

export class Worker {
  private worktreePath: string;

  constructor(public id: string, private emit: (evt: AgentEvent) => void) {
    this.worktreePath = workerWorktreePath(id);
  }

  // v1.0 Project mode — every dispatch starts on a fresh branch off main.
  // setupWorkerWorktree tears down any prior wt-N, recreates the worker's
  // branch from current main, and adds it as a real git worktree so workers
  // inherit the project's scaffolded codebase and any merged peer work.
  async ensureWorktree() {
    try {
      await setupWorkerWorktree(this.id);
      this.emit({ type: 'log', id: this.id, line: `→ git worktree on branch worker-${this.id.slice(1).toLowerCase()}` });
    } catch (e: any) {
      // Fall back to a plain dir so the worker can still write files even if
      // the project repo isn't healthy. Won't be commitable, but better than
      // failing the dispatch outright.
      await fs.mkdir(this.worktreePath, { recursive: true });
      this.emit({ type: 'log', id: this.id, line: `⚠ worktree setup failed (${e.message}) — using plain dir` });
    }
  }

  async execute(subtask: string, imageDataUrl?: string, modelOverride?: string, abortSignal?: AbortSignal): Promise<void> {
    this.emit({ type: 'status', id: this.id, status: 'working' });
    this.emit({ type: 'task', id: this.id, task: subtask });
    this.emit({ type: 'log', id: this.id, line: '→ starting' });

    // Hard 5-minute timeout per worker. Combines with the parent abort signal.
    const localCtrl = new AbortController();
    const timeout = setTimeout(() => {
      this.emit({ type: 'log', id: this.id, line: '⏱ 5-min timeout — auto-cancelled' });
      localCtrl.abort();
    }, 5 * 60 * 1000);
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => localCtrl.abort(), { once: true });
    }
    const effectiveSignal = localCtrl.signal;

    await this.ensureWorktree();

    // If user attached a screenshot, drop it into the worktree so the worker
    // can Read it. Vision-capable Claude models will analyse the PNG.
    let prompt = subtask;
    if (imageDataUrl) {
      try {
        const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        const imgPath = path.join(this.worktreePath, '_screenshot.png');
        await fs.writeFile(imgPath, buf);
        this.emit({ type: 'log', id: this.id, line: '→ screenshot attached as _screenshot.png' });
        prompt = `${subtask}\n\nA screenshot is attached at _screenshot.png in your working directory. Use Read on _screenshot.png FIRST to see what the user is referring to, then proceed with the task.`;
      } catch (e: any) {
        this.emit({ type: 'log', id: this.id, line: `⚠ failed to save screenshot: ${e.message}` });
      }
    }

    const cfg = getAgentConfig(this.id);
    const provider = getProvider(cfg.provider);
    const model = modelOverride ? resolveModelAlias(modelOverride, cfg.provider) : cfg.model;
    const choseTag = modelOverride ? ` (manager-picked: ${modelOverride})` : '';
    this.emit({ type: 'log', id: this.id, line: `· ${cfg.provider}/${model}${choseTag}` });

    try {
      const events: any = {
        onToolCall: (name: string, input: any) => {
          if ((name === 'Run' || name === 'Bash') && input?.command) {
            this.emit({ type: 'log', id: this.id, line: `▶ ${String(input.command).slice(0, 70)}` });
          } else if (name === 'Write' && input?.path) {
            this.emit({ type: 'log', id: this.id, line: `→ Write ${String(input.path).slice(0, 50)}` });
          } else if (name === 'Edit' && input?.path) {
            this.emit({ type: 'log', id: this.id, line: `→ Edit ${String(input.path).slice(0, 50)}` });
          } else {
            this.emit({ type: 'log', id: this.id, line: `→ ${name}` });
          }
        },
        onError: (err: Error) => this.emit({ type: 'log', id: this.id, line: `✗ ${err.message}` }),
        _tokenDelta: (delta: number) => this.emit({ type: 'tokens', id: this.id, delta }),
        _agentId: this.id, // for audit log attribution
      };

      const result = await provider.run(model, {
        systemPrompt: SYSTEM,
        prompt,
        cwd: this.worktreePath,
        // Bumped from 5 to 12 so workers can write → run tests → see failures
        // → fix code → re-run, all in a single agent loop.
        maxTurns: 12,
        abortSignal: effectiveSignal,
      } as any, events);

      clearTimeout(timeout);
      this.emit({ type: 'log', id: this.id, line: `✓ ${result.text.slice(0, 80)}` });
      this.emit({ type: 'status', id: this.id, status: 'done' });
    } catch (err: any) {
      clearTimeout(timeout);
      this.emit({ type: 'log', id: this.id, line: `✗ ${err?.message ?? err}` });
      this.emit({ type: 'status', id: this.id, status: 'error' });
      throw err;
    }
  }
}
