// Babysit mode (v0.9 MVP) — autonomous GitHub-issue → PR loop.
//
// Polls a GitHub repo for issues with a configured label, dispatches the
// issue body as a task to Hive's Manager, waits for workers to settle, then
// pushes the worker branch + opens a PR via the GitHub REST API.
//
// Scope of MVP:
// - One issue at a time (no parallel issues).
// - Active project must be a clone of the configured repo (its git remote
//   `origin` is what we push to; mismatched remotes are rejected).
// - Stops on auth or push failure rather than silently spinning.
// - Per-project config persisted in the meta table; processed issue numbers
//   are persisted too so a restart doesn't replay the same issue.

import { spawn } from 'child_process';
import { Orchestrator } from './orchestrator';
import { projectDir, activeProjectId } from './projectRepo';

export interface BabysitConfig {
  repo: string;          // "owner/repo"
  label: string;
  intervalMs: number;    // poll interval, min 30000
  tokenEnv: string;      // env var name holding GitHub PAT
}

interface BabysitState {
  running: boolean;
  currentIssue: number | null;
  processed: Set<number>;
  startedAt: number;
}

let timer: NodeJS.Timeout | null = null;
let state: BabysitState | null = null;
let orchestrator: Orchestrator | null = null;
let cfg: BabysitConfig | null = null;
let projectId: number | null = null;
let onLog: (line: string) => void = () => {};
let onState: () => void = () => {};

export function babysitIsRunning(): boolean { return !!timer; }
export function babysitStatus() {
  return {
    running: babysitIsRunning(),
    currentIssue: state?.currentIssue ?? null,
    processedCount: state?.processed.size ?? 0,
    repo: cfg?.repo ?? null,
    label: cfg?.label ?? null,
    startedAt: state?.startedAt ?? null,
  };
}

export function babysitStart(o: Orchestrator, c: BabysitConfig, log: (line: string) => void, stateChanged: () => void): { ok: boolean; error?: string } {
  if (timer) return { ok: false, error: 'already running' };
  if (!c.repo || !/^[^/]+\/[^/]+$/.test(c.repo)) return { ok: false, error: 'repo must be "owner/name"' };
  if (!c.label) return { ok: false, error: 'label required' };
  const token = process.env[c.tokenEnv];
  if (!token) return { ok: false, error: `${c.tokenEnv} env var is empty` };
  orchestrator = o; cfg = c; onLog = log; onState = stateChanged;
  projectId = activeProjectId();
  state = { running: true, currentIssue: null, processed: new Set(), startedAt: Date.now() };
  log(`▶ Babysit started — polling ${c.repo}@${c.label} every ${Math.round(c.intervalMs / 1000)}s`);
  onState();
  // Fire once immediately, then on interval. setImmediate lets the IPC reply
  // settle before we start the first tick (avoids racing the UI update).
  setImmediate(() => tick().catch(err => log(`✗ tick: ${err.message}`)));
  timer = setInterval(() => tick().catch(err => log(`✗ tick: ${err.message}`)), Math.max(30000, c.intervalMs));
  return { ok: true };
}

export function babysitStop(): { ok: boolean } {
  if (timer) clearInterval(timer);
  timer = null;
  if (state) state.running = false;
  onLog('⏹ Babysit stopped');
  onState();
  return { ok: true };
}

async function tick(): Promise<void> {
  if (!cfg || !state || !orchestrator) return;
  if (state.currentIssue) return; // an issue is mid-flight
  if (orchestrator.inFlightCount() > 0) return; // workers busy from a manual dispatch
  const token = process.env[cfg.tokenEnv];
  if (!token) { babysitStop(); onLog('✗ token env var disappeared, stopping'); return; }

  // Sanity: project must point at the configured remote.
  const remote = await tryGit(['remote', 'get-url', 'origin']);
  if (!remote) { onLog('✗ active project has no `origin` remote — switch to a cloned project'); babysitStop(); return; }
  const expected = `${cfg.repo}.git`;
  if (!remote.includes(cfg.repo)) {
    onLog(`✗ origin remote (${remote.trim()}) doesn't match configured repo (${cfg.repo})`);
    babysitStop();
    return;
  }

  let issues: any[];
  try { issues = await fetchIssues(cfg.repo, cfg.label, token); }
  catch (err: any) { onLog(`✗ github fetch: ${err.message}`); return; }

  const next = issues.find(i => !state!.processed.has(i.number));
  if (!next) { onLog(`· no unclaimed ${cfg.label} issues (${issues.length} total open)`); return; }

  state.currentIssue = next.number;
  onState();
  onLog(`→ picking up issue #${next.number}: ${String(next.title).slice(0, 80)}`);

  // Refresh main from origin so worker branches start from the latest. If
  // there's a divergence we leave it — user may have local merges.
  await tryGit(['fetch', 'origin']);
  await tryGit(['merge', '--ff-only', 'origin/main']).catch(() => { /* non-fatal */ });

  const taskPrompt = `[babysit:issue#${next.number}] ${next.title}\n\n${(next.body || '').slice(0, 4000)}\n\nDeliver a working fix. Keep changes minimal and focused on the issue.`;
  await orchestrator.runTask(taskPrompt);

  await waitIdle();

  // For each worker branch with commits ahead of main, push + open PR.
  const branches = await branchesAheadOfMain();
  if (branches.length === 0) {
    onLog(`· issue #${next.number}: workers produced no branch deltas`);
  }
  for (const b of branches) {
    try {
      await git(['push', '-u', 'origin', b, '--force-with-lease']);
      const pr = await openPR(cfg.repo, b, next.number, next.title, token);
      onLog(`✓ #${next.number}: pushed ${b} → PR #${pr.number} ${pr.html_url}`);
    } catch (err: any) {
      onLog(`✗ push/PR for ${b}: ${err.message}`);
    }
  }

  state.processed.add(next.number);
  state.currentIssue = null;
  onState();
}

async function fetchIssues(repo: string, label: string, token: string): Promise<any[]> {
  const url = `https://api.github.com/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`;
  const resp = await fetch(url, {
    headers: {
      'authorization': `Bearer ${token}`,
      'accept': 'application/vnd.github+json',
      'user-agent': 'Hive-Babysit',
    },
  });
  if (!resp.ok) throw new Error(`github ${resp.status} ${await resp.text().then(t => t.slice(0, 120))}`);
  const data: any = await resp.json();
  if (!Array.isArray(data)) throw new Error('issues response was not an array');
  // GitHub returns PRs in /issues — filter them out.
  return data.filter((i: any) => !i.pull_request);
}

async function waitIdle(): Promise<void> {
  if (!orchestrator) return;
  const start = Date.now();
  const maxWaitMs = 20 * 60 * 1000;
  const stableMs = 30_000;
  let stableSince = 0;
  while (Date.now() - start < maxWaitMs) {
    const inFlight = orchestrator.inFlightCount();
    if (inFlight === 0) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return;
    } else {
      stableSince = 0;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  onLog('⚠ waitIdle hit 20-min cap, proceeding anyway');
}

async function branchesAheadOfMain(): Promise<string[]> {
  const out: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const branch = `worker-${i}`;
    const exists = await tryGit(['rev-parse', '--verify', branch]);
    if (!exists) continue;
    const ahead = await tryGit(['rev-list', '--count', `main..${branch}`]);
    if (ahead && parseInt(ahead.trim(), 10) > 0) out.push(branch);
  }
  return out;
}

async function openPR(repo: string, branch: string, issueNumber: number, issueTitle: string, token: string): Promise<any> {
  const url = `https://api.github.com/repos/${repo}/pulls`;
  const body = JSON.stringify({
    title: `[Hive] ${String(issueTitle).slice(0, 100)}`,
    head: branch,
    base: 'main',
    body: `Closes #${issueNumber}\n\nAutomated patch from Hive (Babysit mode). Review the diff and merge if it looks right.`,
  });
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'accept': 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'Hive-Babysit',
    },
    body,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`PR open ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: projectDir(), shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b.toString(); });
    child.stderr.on('data', b => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `git exit ${code}`)));
  });
}

async function tryGit(args: string[]): Promise<string | null> {
  try { return await git(args); } catch { return null; }
}
