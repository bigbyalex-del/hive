import * as path from 'path';
import * as fs from 'fs/promises';
import { AgentEvent } from '../shared/types';
import { getProvider } from './providers/registry';
import { getAgentConfig } from './config';
import { ProviderName } from './providers/types';

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

You have these built-in tools: Read, Write, Edit, Glob, Grep, Run, Fetch.

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

## Workflow
1. Use Glob/Grep first if you don't know the file structure.
2. Implement with Write/Edit.
3. **Verify**: if a project has tests, run them. If TypeScript matters, run \`npx tsc --noEmit\`. Read the exit code and any errors.
4. **Self-correct**: if a check fails, read the error, fix the code, re-run. Up to 3 retries.
5. When everything works (or there's nothing to verify), reply with ONE short sentence summarising what you did and what evidence proves it works.

Do not ask clarifying questions — make a reasonable interpretation and proceed. Do not over-engineer. Match the scope of the request.`;

export class Worker {
  private worktreePath: string;

  constructor(public id: string, private emit: (evt: AgentEvent) => void) {
    const idx = id.slice(1);
    this.worktreePath = path.join(process.cwd(), 'worktrees', `wt-${idx}`);
  }

  async ensureWorktree() {
    await fs.mkdir(this.worktreePath, { recursive: true });
  }

  async execute(subtask: string, imageDataUrl?: string, modelOverride?: string, abortSignal?: AbortSignal): Promise<void> {
    this.emit({ type: 'status', id: this.id, status: 'working' });
    this.emit({ type: 'task', id: this.id, task: subtask });
    this.emit({ type: 'log', id: this.id, line: '→ starting' });

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
        abortSignal,
      } as any, events);

      this.emit({ type: 'log', id: this.id, line: `✓ ${result.text.slice(0, 80)}` });
      this.emit({ type: 'status', id: this.id, status: 'done' });
    } catch (err: any) {
      this.emit({ type: 'log', id: this.id, line: `✗ ${err?.message ?? err}` });
      this.emit({ type: 'status', id: this.id, status: 'error' });
      throw err;
    }
  }
}
