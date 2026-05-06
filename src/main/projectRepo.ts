// v1.0 Project mode — one parent repo per project at worktrees/projects/<slug>,
// each worker dispatches into a real `git worktree` under that project on its
// own branch (worker-1..worker-8). Switching the active project changes the
// path returned by projectDir() / workerWorktreePath() so subsequent dispatches
// land in the new project's tree.
//
// The legacy "default" project lives at worktrees/project/ for backward
// compatibility with pre-projects history.

import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';

// Active project state — driven by setActiveProject() at app start and on
// user-initiated project switch. We keep both `dir` (relative to cwd, taken
// straight from the projects table) and the resolved absolute path so callers
// don't have to know the layout.
interface ActiveProject { id: number; dir: string; absDir: string; }
let active: ActiveProject = {
  id: 1,
  dir: 'worktrees/project',
  absDir: path.join(process.cwd(), 'worktrees', 'project'),
};

// Per-project init guard — when we switch projects, the new one needs its
// own ensureProjectRepo() pass before workers fan out.
const initialisedProjects = new Set<number>();

// Serialise all ops that touch any parent repo — branch create, merge, etc.
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

export function setActiveProject(opts: { id: number; dir: string }): void {
  active = {
    id: opts.id,
    dir: opts.dir,
    absDir: path.isAbsolute(opts.dir) ? opts.dir : path.join(process.cwd(), opts.dir),
  };
}

export function activeProjectId(): number { return active.id; }
export function projectDir(): string { return active.absDir; }

export function workerWorktreePath(workerId: string): string {
  const idx = workerId.replace(/^W/i, '');
  // Per-project worker dirs live under the project's _workers/ folder so two
  // projects don't collide on wt-N. The legacy default project keeps its
  // historic top-level wt-N layout so existing on-disk worktrees still work.
  if (active.id === 1) {
    return path.join(process.cwd(), 'worktrees', `wt-${idx}`);
  }
  return path.join(active.absDir, '_workers', `wt-${idx}`);
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

const GITIGNORE = [
  'node_modules/',
  '.hive-screenshots/',
  '_test_*.png',
  '_screenshot.png',
  '_workers/',
  '.DS_Store',
  'Thumbs.db',
  '',
].join('\n');

// Idempotent. Creates the active project's repo directory if missing, inits
// it as a git repo with an empty initial commit on main so worker branches
// can be created off it. Per-project guard so a switch triggers re-init.
export async function ensureProjectRepo(): Promise<void> {
  const id = active.id;
  if (initialisedProjects.has(id)) return;
  const dir = active.absDir;
  await fs.mkdir(dir, { recursive: true });
  const isRepo = await exists(path.join(dir, '.git'));
  if (!isRepo) {
    await run(dir, ['init', '-b', 'main']);
    await run(dir, ['config', 'user.email', 'hive@youraihive.com']);
    await run(dir, ['config', 'user.name', 'Hive']);
    await fs.writeFile(path.join(dir, '.gitignore'), GITIGNORE, 'utf8');
    await run(dir, ['add', '.gitignore']);
    await run(dir, ['commit', '-m', 'init']);
  } else {
    await run(dir, ['config', 'user.email', 'hive@youraihive.com']).catch(() => {});
    await run(dir, ['config', 'user.name', 'Hive']).catch(() => {});
    const gi = path.join(dir, '.gitignore');
    if (!await exists(gi)) {
      await fs.writeFile(gi, GITIGNORE, 'utf8');
      await run(dir, ['add', '.gitignore'], { ignoreExit: true });
      await run(dir, ['commit', '-m', 'add .gitignore'], { ignoreExit: true });
    }
  }
  initialisedProjects.add(id);
}

// Tear down any existing worktree at wt-N, force-recreate the worker's branch
// off current main, add a fresh worktree at wt-N pointing at that branch.
export async function setupWorkerWorktree(workerId: string): Promise<string> {
  await ensureProjectRepo();
  const wtPath = workerWorktreePath(workerId);
  const branch = workerBranch(workerId);

  return withMutex(async () => {
    // Remove any prior worktree registration. Ignore failure — wt may not exist.
    await run(active.absDir, ['worktree', 'remove', wtPath, '--force'], { ignoreExit: true });
    // Belt-and-braces: physically delete the directory in case worktree remove
    // didn't (e.g. git lost track of it).
    await fs.rm(wtPath, { recursive: true, force: true }).catch(() => {});
    // Drop the old branch if it exists so we always start from current main.
    await run(active.absDir, ['branch', '-D', branch], { ignoreExit: true });
    // Create branch + add worktree atomically.
    await run(active.absDir, ['worktree', 'add', '-b', branch, wtPath, 'main']);
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
    const branchCheck = await run(active.absDir, ['rev-parse', '--verify', branch], { ignoreExit: true });
    if (branchCheck.code !== 0) return { ok: false, error: `branch ${branch} does not exist` };

    // Fast path: no commits ahead of main → nothing to merge.
    const ahead = await run(active.absDir, ['rev-list', '--count', `main..${branch}`], { ignoreExit: true });
    if (ahead.stdout.trim() === '0') return { ok: true, alreadyMerged: true };

    const trimmed = summary.length > 160 ? summary.slice(0, 157) + '…' : summary;
    const merge = await run(
      active.absDir,
      ['merge', '--no-ff', '-m', `Merge ${branch}: ${trimmed}`, branch],
      { ignoreExit: true },
    );
    if (merge.code === 0) return { ok: true };

    // Conflict — read conflicted files, abort the merge to leave main clean.
    const status = await run(active.absDir, ['status', '--porcelain'], { ignoreExit: true });
    const conflicted = status.stdout.split('\n')
      .filter(l => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('DD'))
      .map(l => l.slice(3).trim())
      .filter(Boolean);
    await run(active.absDir, ['merge', '--abort'], { ignoreExit: true });
    return { ok: false, conflict: conflicted, error: 'merge conflict' };
  });
}

// Returns `{ stat, patch }` for `main..worker-N`. Empty strings if branch
// doesn't exist or has no diff.
export async function diffWorkerBranch(workerId: string): Promise<{ stat: string; patch: string }> {
  await ensureProjectRepo();
  const branch = workerBranch(workerId);
  const exists = await run(active.absDir, ['rev-parse', '--verify', branch], { ignoreExit: true });
  if (exists.code !== 0) return { stat: '', patch: '' };
  const stat = await run(active.absDir, ['diff', `main...${branch}`, '--stat'], { ignoreExit: true });
  const patch = await run(active.absDir, ['diff', `main...${branch}`], { ignoreExit: true });
  return { stat: stat.stdout, patch: patch.stdout };
}

// Commit changes already written into the project root (used by template
// scaffolding so the codebase is on main before any worker branches off it).
export async function commitProjectChanges(message: string): Promise<boolean> {
  await ensureProjectRepo();
  return withMutex(async () => {
    const status = await run(active.absDir, ['status', '--porcelain'], { ignoreExit: true });
    if (!status.stdout.trim()) return false;
    await run(active.absDir, ['add', '-A']);
    const trimmed = message.length > 160 ? message.slice(0, 157) + '…' : message;
    await run(active.absDir, ['commit', '-m', trimmed]);
    return true;
  });
}
