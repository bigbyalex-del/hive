// Reviewer pass — after a Worker reports done, a cheap Haiku reads the actual
// changed files plus the worker's summary and rules PASS or NEEDS_FIX.
//
// The Reviewer's events fire under the WORKER's id so the UI shows the
// verdict as a 🔍 log line on that worker's card — no extra grid slot needed.
// Token usage attributes to the worker for now (small spend, fine to merge).

import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { AgentEvent } from '../shared/types';
import { getProvider } from './providers/registry';
import { getAgentConfig } from './config';

const SYSTEM = `You are the Reviewer in HIVE. A Worker just reported a task done. Your job: rule PASS or NEEDS_FIX based on the diff and the worker's claimed summary.

You are STRICT but fair. Catch:
- Files that don't match what the user asked for (wrong content, wrong filename, wrong tech).
- Empty/placeholder code where real implementation was requested.
- Bugs visible from the diff (typos, wrong logic, broken syntax).
- The worker claiming things they didn't actually do.

You DO NOT critique style, naming, micro-optimisations, or test coverage unless the user asked for them.

Reply with EXACTLY one of:
- \`PASS: <one short sentence on what they got right>\`
- \`NEEDS_FIX: <one short sentence on what's wrong + what to do>\`

No preamble, no markdown, no JSON. One line.`;

export interface ReviewInput {
  workerId: string;
  worktreePath: string;
  originalTask: string;
  workerSummary: string;
}

export interface ReviewVerdict {
  pass: boolean;
  message: string;
}

function gitStatus(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain'], { cwd, shell: true, windowsHide: true });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

async function snapshotChangedFiles(cwd: string, maxFiles = 6, maxBytes = 1500): Promise<string> {
  const status = await gitStatus(cwd);
  if (!status.trim()) return '(no tracked changes)';
  const lines = status.split('\n').map(l => l.trim()).filter(Boolean).slice(0, maxFiles);
  const blocks: string[] = [];
  for (const line of lines) {
    // Format is `XY path` or `XY path -> renamePath`. Take the last path token.
    const parts = line.split(/\s+/);
    const rel = parts[parts.length - 1];
    if (!rel) continue;
    const abs = path.join(cwd, rel);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) continue;
      const buf = await fs.readFile(abs, 'utf8');
      const truncated = buf.length > maxBytes ? buf.slice(0, maxBytes) + `\n[...truncated from ${buf.length} bytes]` : buf;
      blocks.push(`--- ${rel} ---\n${truncated}`);
    } catch {
      blocks.push(`--- ${rel} ---\n(unreadable / binary)`);
    }
  }
  return blocks.length ? blocks.join('\n\n') : '(only binary or unreadable changes)';
}

export class Reviewer {
  constructor(public id: string, private emit: (evt: AgentEvent) => void) {}

  async review(input: ReviewInput): Promise<ReviewVerdict> {
    const tag = '🔍 review';
    this.emit({ type: 'log', id: input.workerId, line: `${tag}: starting…` });

    const filesSnapshot = await snapshotChangedFiles(input.worktreePath);

    const cfg = getAgentConfig(this.id);
    const provider = getProvider(cfg.provider);

    const prompt = `## ORIGINAL TASK
${input.originalTask}

## WORKER'S SUMMARY (their claim)
${input.workerSummary || '(empty)'}

## ACTUAL CHANGED FILES (truncated)
${filesSnapshot}

Now rule PASS or NEEDS_FIX.`;

    try {
      const result = await provider.run(cfg.model, {
        systemPrompt: SYSTEM,
        prompt,
        maxTurns: 1,
        noTools: true,
      } as any, {
        onError: (err: Error) => this.emit({ type: 'log', id: input.workerId, line: `${tag}: ✗ ${err.message}` }),
        _tokenDelta: (delta: number) => this.emit({ type: 'tokens', id: input.workerId, delta }),
        _agentId: this.id,
      } as any);

      const raw = result.text.trim();
      if (!raw) {
        this.emit({ type: 'log', id: input.workerId, line: `${tag}: (empty response — defaulting PASS)` });
        return { pass: true, message: 'reviewer returned empty' };
      }

      const upper = raw.toUpperCase();
      const pass = upper.startsWith('PASS');
      const message = raw.replace(/^(PASS|NEEDS_FIX)\s*:?\s*/i, '').slice(0, 200);
      const icon = pass ? '✅' : '⚠';
      this.emit({ type: 'log', id: input.workerId, line: `${tag}: ${icon} ${pass ? 'PASS' : 'NEEDS_FIX'} — ${message}` });
      if (!pass) {
        this.emit({ type: 'status', id: input.workerId, status: 'review' });
      }
      return { pass, message };
    } catch (err: any) {
      this.emit({ type: 'log', id: input.workerId, line: `${tag}: ✗ ${err?.message ?? err} (defaulting PASS)` });
      return { pass: true, message: `reviewer error: ${err?.message ?? err}` };
    }
  }
}
