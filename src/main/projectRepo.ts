// v1.0 Project mode — one parent repo at worktrees/project/, each worker
// dispatches into a real `git worktree` on its own branch (worker-1..worker-8).
// On Reviewer PASS, orchestrator commits the worker's changes and merges the
// branch back into main. Conflicts surface as a 'review' status with a
// "merge conflict" log line — manual resolution for now.

import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';

const PROJECT_DIR = path.join(process.cwd(), 'worktrees', 'project');

let initialised = false;
// Serialise all ops that touch the parent repo — branch create, merge, etc.
// Worker working-tree edits are isolated by directory so they don't need this.
let repoMutex: Promise<void> = Promise.resolve();
async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = repoMutex;
  let release!: () => void;
  repoMutex = new Promise<void>(r => { release = r; });
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

export function projectDir(): string { return PROJECT_DIR; }

export function workerWorktreePath(workerId: string): string {
  const idx = workerId.replace(/^W/i, '');
  return path.join(process.cwd(), 'worktrees', `wt-${idx}`);
}

export function workerBranch(workerId: string): string {
  const idx = workerId.replace(/^W/i, '').toLowerCase();
  return `worker-${idx}`;
}

interface RunOpts { ignoreExit?: boolean }
function run(cwd: string, args: string[], opts: RunOpts = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b.toString(); });
    child.stderr.on('data', b => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      const c = code ?? -1;
      if (c !== 0 && !opts.ignoreExit) {
        const err = new Error(`git ${args.join(' ')} exited ${c}: ${stderr.trim() || stdout.trim()}`);
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        (err as any).code = c;
        return reject(err);
      }
      resolve({ code: c, stdout, stderr });
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// Idempotent. Creates worktrees/project/ if missing, inits as a git repo with
// an empty initial commit on main so worker branches can be created off it.
export async function ensureProjectRepo(): Promise<void> {
  if (initialised) return;
  await fs.mkdir(PROJECT_DIR, { recursive: true });
  const isRepo = await exists(path.join(PROJECT_DIR, '.git'));
  if (!isRepo) {
    await run(PROJECT_DIR, ['init', '-b', 'main']);
    await run(PROJECT_DIR, ['config', 'user.email', 'hive@youraihive.com']);
    await run(PROJECT_DIR, ['config', 'user.name', 'Hive']);
    // Empty initial commit so we can create branches off main before any
    // template scaffolds files.
    await run(PROJECT_DIR, ['commit', '--allow-empty', '-m', 'init']);
  } else {
    // Make sure config is set even on existing repos (recovery path).
    await run(PROJECT_DIR, ['config', 'user.email', 'hive@youraihive.com']).catch(() => {});
    await run(PROJECT_DIR, ['config', 'user.name', 'Hive']).catch(() => {});
  }
  initialised = true;
}

// Tear down any existing worktree at wt-N, force-recreate the worker's branch
// off current main, add a fresh worktree at wt-N pointing at that branch.
export async function setupWorkerWorktree(workerId: string): Promise<string> {
  await ensureProjectRepo();
  const wtPath = workerWorktreePath(workerId);
  const branch = workerBranch(workerId);

  return withMutex(async () => {
    // Remove any prior worktree registration. Ignore failure — wt may not exist.
    await run(PROJECT_DIR, ['worktree', 'remove', wtPath, '--force'], { ignoreExit: true });
    // Belt-and-braces: physically delete the directory in case worktree remove
    // didn't (e.g. git lost track of it).
    await fs.rm(wtPath, { recursive: true, force: true }).catch(() => {});
    // Drop the old branch if it exists so we always start from current main.
    await run(PROJECT_DIR, ['branch', '-D', branch], { ignoreExit: true });
    // Create branch + add worktree atomically.
    await run(PROJECT_DIR, ['worktree', 'add', '-b', branch, wtPath, 'main']);
    return wtPath;
  });
}

// Commits all changes in the worker's worktree to its branch. Returns false
// if there were no changes to commit (worker did nothing tangible).
export async function commitWorkerChanges(workerId: string, message: string): Promise<boolean> {
  const wtPath = workerWorktreePath(workerId);
  if (!await exists(wtPath)) return false;
  const status = await run(wtPath, ['status', '--porcelain'], { ignoreExit: true });
  if (!status.stdout.trim()) return false;
  await run(wtPath, ['add', '-A']);
  // Truncate message — git is fine with long but UI cards aren't.
  const trimmed = message.length > 160 ? message.slice(0, 157) + '…' : message;
  await run(wtPath, ['commit', '-m', trimmed || 'worker output']);
  return true;
}

export interface MergeResult {
  ok: boolean;
  alreadyMerged?: boolean;
  conflict?: string[];
  error?: string;
}

// Merge worker-N into main on the parent repo. Serialised via repoMutex so
// two simultaneous worker completions don't race on the same HEAD.
export async function mergeWorkerBranch(workerId: string, summary: string): Promise<MergeResult> {
  await ensureProjectRepo();
  const branch = workerBranch(workerId);

  return withMutex<MergeResult>(async () => {
    // Confirm branch exists.
    const branchCheck = await run(PROJECT_DIR, ['rev-parse', '--verify', branch], { ignoreExit: true });
    if (branchCheck.code !== 0) return { ok: false, error: `branch ${branch} does not exist` };

    // Fast path: no commits ahead of main → nothing to merge.
    const ahead = await run(PROJECT_DIR, ['rev-list', '--count', `main..${branch}`], { ignoreExit: true });
    if (ahead.stdout.trim() === '0') return { ok: true, alreadyMerged: true };

    const trimmed = summary.length > 160 ? summary.slice(0, 157) + '…' : summary;
    const merge = await run(
      PROJECT_DIR,
      ['merge', '--no-ff', '-m', `Merge ${branch}: ${trimmed}`, branch],
      { ignoreExit: true },
    );
    if (merge.code === 0) return { ok: true };

    // Conflict — read conflicted files, abort the merge to leave main clean.
    const status = await run(PROJECT_DIR, ['status', '--porcelain'], { ignoreExit: true });
    const conflicted = status.stdout.split('\n')
      .filter(l => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('DD'))
      .map(l => l.slice(3).trim())
      .filter(Boolean);
    await run(PROJECT_DIR, ['merge', '--abort'], { ignoreExit: true });
    return { ok: false, conflict: conflicted, error: 'merge conflict' };
  });
}

// Returns `{ stat, patch }` for `main..worker-N`. Empty strings if branch
// doesn't exist or has no diff.
export async function diffWorkerBranch(workerId: string): Promise<{ stat: string; patch: string }> {
  await ensureProjectRepo();
  const branch = workerBranch(workerId);
  const exists = await run(PROJECT_DIR, ['rev-parse', '--verify', branch], { ignoreExit: true });
  if (exists.code !== 0) return { stat: '', patch: '' };
  const stat = await run(PROJECT_DIR, ['diff', `main...${branch}`, '--stat'], { ignoreExit: true });
  const patch = await run(PROJECT_DIR, ['diff', `main...${branch}`], { ignoreExit: true });
  return { stat: stat.stdout, patch: patch.stdout };
}

// Commit changes already written into the project root (used by template
// scaffolding so the codebase is on main before any worker branches off it).
export async function commitProjectChanges(message: string): Promise<boolean> {
  await ensureProjectRepo();
  return withMutex(async () => {
    const status = await run(PROJECT_DIR, ['status', '--porcelain'], { ignoreExit: true });
    if (!status.stdout.trim()) return false;
    await run(PROJECT_DIR, ['add', '-A']);
    const trimmed = message.length > 160 ? message.slice(0, 157) + '…' : message;
    await run(PROJECT_DIR, ['commit', '-m', trimmed]);
    return true;
  });
}
