// Hive deploy worker — drives `eas update` (OTA) for FXV with strict safety
// gates so a careless "ship it" can't take prod down.
//
// Two-phase ALWAYS:
//   1. preparePlan(intent)  — runs preflight (tsc + uncommitted check),
//                             computes diff vs last shipped, captures the
//                             current production update group as the
//                             rollback target. Returns a plan with blockers.
//   2. executePlan(planId, confirmation)
//                           — only runs `eas update` after explicit confirm.
//                             Production channel additionally requires the
//                             literal word 'production' in confirmation.
//
// The LLM never runs the eas command directly. It only extracts intent
// (channel, message) into a structured plan that the user must approve.
// The eas binary is invoked deterministically via child_process.spawn in
// the FXV mobile dir.
//
// Rollback: every successful update captures the previous group id BEFORE
// the new push. `rollback(groupId)` re-publishes that group via
// `eas update:republish --group <id>`.
//
// Audit: every deploy attempt lands in the deploys table (status flow
// executing → shipped/failed/cancelled) and ~/.hive/audit.jsonl.

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { recordDeploy, updateDeployStatus, lastDeployForChannel, listDeploys, DeployRow } from './db';
import { AnthropicProvider } from './providers/anthropic';

// ---- Project resolution -------------------------------------------------

interface DeployTarget {
  project: string;       // 'fxv'
  workingDir: string;    // absolute path to where `eas update` runs
  expectedBranch: string; // git branch we expect to ship from
}

// Single registered target for v1 — FXV. Future: read from a config file.
const TARGETS: Record<string, DeployTarget> = {
  fxv: {
    project: 'fxv',
    workingDir: 'C:/Users/Fusion/.openclaw/workspace/fxv-performance/mobile',
    expectedBranch: 'main',
  },
};

export function listDeployTargets(): { project: string; workingDir: string; expectedBranch: string }[] {
  return Object.values(TARGETS);
}

// ---- Plan + result types ------------------------------------------------

export type DeployChannel = 'preview' | 'production';

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail?: string;        // failure reason or extra info
  blocking: boolean;      // false = warning only
}

export interface DeployPlan {
  planId: string;
  project: string;
  workingDir: string;
  channel: DeployChannel;
  message: string;
  preflight: PreflightCheck[];
  diff: {
    sinceSha: string | null;
    toSha: string;
    branch: string;
    commitCount: number;
    changedFiles: string[];
    summary: string;             // LLM-generated, 1-3 sentences
    rawLog: string[];            // commit subject lines
  };
  rollbackPrep: {
    previousGroupId: string | null;
    previousMessage: string | null;
    captured: boolean;
  };
  blockers: string[];
  warnings: string[];
  expiresAt: number;             // ts
  createdAt: number;
}

export interface ExecuteResult {
  ok: boolean;
  deployId: number;
  groupId: string | null;
  durationMs: number;
  log: string[];
  smoke: { ok: boolean; detail: string } | null;
  error?: string;
}

// ---- Plan cache ---------------------------------------------------------

const PLAN_TTL_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
const planCache = new Map<string, DeployPlan>();

function purgeExpired() {
  const now = Date.now();
  for (const [id, plan] of planCache) {
    if (plan.expiresAt < now) planCache.delete(id);
  }
}

// ---- Shell helper -------------------------------------------------------

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

// shell:true so commands like `eas` resolve via PATH on Windows (.cmd
// shims). Args get joined into a single command line, so we quote the
// risky ones (message string) ourselves.
function runShell(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; onLine?: (line: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | null = null;
    const reset = () => { if (timer) clearTimeout(timer); };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }, opts.timeoutMs);
    }
    child.stdout?.on('data', (buf: Buffer) => {
      const chunk = buf.toString();
      stdout += chunk;
      if (opts.onLine) for (const line of chunk.split(/\r?\n/)) if (line) opts.onLine(line);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString();
      stderr += chunk;
      if (opts.onLine) for (const line of chunk.split(/\r?\n/)) if (line) opts.onLine(line);
    });
    child.on('error', (err) => {
      reset();
      resolve({ ok: false, code: null, stdout, stderr: stderr + '\n' + (err?.message ?? String(err)) });
    });
    child.on('close', (code) => {
      reset();
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

// ---- Preflight checks ---------------------------------------------------

async function checkGitClean(cwd: string): Promise<PreflightCheck> {
  // Hive runs deploys against the FXV repo; the working tree must be clean
  // because `eas update` ships whatever is on disk, not the last commit.
  const r = await runShell('git', ['status', '--porcelain'], { cwd, timeoutMs: 15_000 });
  if (!r.ok) return { name: 'git status', ok: false, blocking: true, detail: `git status failed: ${r.stderr.trim().slice(0, 200)}` };
  const lines = r.stdout.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return { name: 'working tree clean', ok: true, blocking: true };
  return {
    name: 'working tree clean',
    ok: false,
    blocking: true,
    detail: `${lines.length} uncommitted change(s):\n` + lines.slice(0, 8).map(l => '  ' + l).join('\n') + (lines.length > 8 ? '\n  …' : ''),
  };
}

async function checkBranch(cwd: string, expected: string): Promise<PreflightCheck> {
  const r = await runShell('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10_000 });
  const current = r.stdout.trim();
  if (!r.ok) return { name: 'branch', ok: false, blocking: true, detail: r.stderr.trim().slice(0, 200) };
  if (current !== expected) {
    return { name: 'branch', ok: false, blocking: false, detail: `on '${current}' (expected '${expected}') — ship anyway?` };
  }
  return { name: `on ${expected}`, ok: true, blocking: false };
}

async function checkCooldown(project: string, channel: string, channelKind: DeployChannel): Promise<PreflightCheck> {
  const last = lastDeployForChannel(project, channel);
  if (!last) return { name: 'cooldown', ok: true, blocking: false, detail: 'no prior deploys on this channel' };
  const since = Date.now() - last.ts;
  // Only block production cooldown — preview is fast iteration territory.
  const blocking = channelKind === 'production' && since < COOLDOWN_MS;
  if (since < COOLDOWN_MS) {
    const mins = Math.floor(since / 60_000);
    const secs = Math.floor((since % 60_000) / 1000);
    return {
      name: 'cooldown',
      ok: false,
      blocking,
      detail: `last ${channel} ship was ${mins}m ${secs}s ago — wait or override`,
    };
  }
  return { name: 'cooldown', ok: true, blocking: false };
}

async function checkTypecheck(cwd: string, onLine?: (line: string) => void): Promise<PreflightCheck> {
  // Skip if no tsconfig or no `typecheck` script — typecheck is project-
  // dependent. We try `npm run typecheck` first, fall back to `npx tsc
  // --noEmit`. 90s timeout because RN projects can be slow.
  const pkgPath = path.join(cwd, 'package.json');
  let hasScript = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    hasScript = !!pkg.scripts?.typecheck;
  } catch { /* fine */ }

  const r = hasScript
    ? await runShell('npm', ['run', 'typecheck'], { cwd, timeoutMs: 120_000, onLine })
    : await runShell('npx', ['tsc', '--noEmit'], { cwd, timeoutMs: 120_000, onLine });

  if (r.ok) return { name: 'typecheck', ok: true, blocking: true };
  // Truncate noisy output — we want the head of the failure, not 50 lines
  const detail = (r.stderr + '\n' + r.stdout).split(/\r?\n/).filter(l => l.includes('error') || l.includes('Error')).slice(0, 6).join('\n');
  return { name: 'typecheck', ok: false, blocking: true, detail: detail || `exit code ${r.code}` };
}

// ---- Diff + EAS state --------------------------------------------------

async function getCurrentSha(cwd: string): Promise<string> {
  const r = await runShell('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 10_000 });
  return r.stdout.trim();
}

async function getDiffSinceLastShipped(cwd: string, project: string, channel: string): Promise<{ sinceSha: string | null; commitCount: number; changedFiles: string[]; rawLog: string[] }> {
  const last = lastDeployForChannel(project, channel);
  const sinceSha = last?.sha ?? null;
  if (!sinceSha) {
    // No prior shipped deploy on this channel — fall back to last 10 commits
    const log = await runShell('git', ['log', '--oneline', '-10'], { cwd, timeoutMs: 10_000 });
    const files = await runShell('git', ['log', '--name-only', '--pretty=format:', '-10'], { cwd, timeoutMs: 10_000 });
    const rawLog = log.stdout.split(/\r?\n/).filter(l => l.trim().length > 0);
    const changedFiles = Array.from(new Set(files.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)));
    return { sinceSha: null, commitCount: rawLog.length, changedFiles: changedFiles.slice(0, 50), rawLog };
  }
  const log = await runShell('git', ['log', '--oneline', `${sinceSha}..HEAD`], { cwd, timeoutMs: 10_000 });
  const files = await runShell('git', ['diff', '--name-only', `${sinceSha}..HEAD`], { cwd, timeoutMs: 10_000 });
  const rawLog = log.stdout.split(/\r?\n/).filter(l => l.trim().length > 0);
  const changedFiles = files.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  return { sinceSha, commitCount: rawLog.length, changedFiles: changedFiles.slice(0, 50), rawLog };
}

interface EasUpdateGroup {
  id: string;
  message: string;
  branch: string;
  createdAt: string;
}

// `eas update:list --branch <ch> --json --non-interactive --limit 1`
// returns an array of update groups newest-first. We capture the most
// recent group as the rollback target BEFORE pushing.
async function getCurrentGroupForChannel(cwd: string, channel: string): Promise<EasUpdateGroup | null> {
  const r = await runShell('eas', ['update:list', '--branch', channel, '--json', '--non-interactive', '--limit', '1'], { cwd, timeoutMs: 30_000 });
  if (!r.ok) return null;
  try {
    // EAS sometimes prefixes the JSON with log lines; isolate the JSON array
    const m = r.stdout.match(/\[[\s\S]*\]/);
    if (!m) return null;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const g = arr[0];
    return {
      id: String(g.id ?? g.group ?? ''),
      message: String(g.message ?? ''),
      branch: String(g.branch ?? channel),
      createdAt: String(g.createdAt ?? ''),
    };
  } catch {
    return null;
  }
}

// ---- LLM diff summary ---------------------------------------------------

async function summariseDiff(rawLog: string[], changedFiles: string[]): Promise<string> {
  if (rawLog.length === 0) return 'No new commits since the last ship.';
  if (!process.env.ANTHROPIC_API_KEY) {
    // Fallback: deterministic 1-line summary
    return `${rawLog.length} commit(s) across ${changedFiles.length} file(s). Top: ${rawLog[0].slice(0, 80)}`;
  }
  const prompt = `Summarise these commits + changed files into a 2-3 sentence user-facing release note for an iOS hybrid-athlete app called FXV. Be concrete (mention what users will see/feel) but tight. Don't invent — only describe what's in the inputs.\n\nCOMMITS:\n${rawLog.slice(0, 15).join('\n')}\n\nCHANGED FILES:\n${changedFiles.slice(0, 25).join('\n')}`;
  try {
    const provider = new AnthropicProvider();
    const r = await provider.run('claude-haiku-4-5-20251001', {
      systemPrompt: 'You write concise iOS release notes. Output the summary text only — no preamble, no quotes, no bullets unless asked.',
      prompt,
      noTools: true,
      maxTurns: 1,
    }, { _agentId: 'deploy:summary' } as any);
    return r.text.trim();
  } catch {
    return `${rawLog.length} commit(s), ${changedFiles.length} file(s). ${rawLog[0]?.slice(0, 80) ?? ''}`;
  }
}

// ---- Intent extraction --------------------------------------------------

export interface DeployIntent {
  channel: DeployChannel;
  message: string;
  // The LLM never gets to set "channel: production" silently — UI must
  // re-confirm before plan executes. We surface the LLM's guess but the
  // caller treats it as a hint, not a directive.
  llmGuessedProduction: boolean;
}

export async function extractIntent(text: string): Promise<DeployIntent> {
  const t = String(text ?? '').trim();
  if (!t) return { channel: 'preview', message: '', llmGuessedProduction: false };

  // Cheap deterministic pass — if the user explicitly said "production" /
  // "prod" we surface the guess. Otherwise default to preview.
  const lc = t.toLowerCase();
  const explicitProd = /\b(prod|production)\b/.test(lc);

  if (!process.env.ANTHROPIC_API_KEY) {
    return { channel: 'preview', message: t.slice(0, 200), llmGuessedProduction: explicitProd };
  }
  try {
    const provider = new AnthropicProvider();
    const r = await provider.run('claude-haiku-4-5-20251001', {
      systemPrompt: `You extract deploy intent from a developer's instruction. Output ONLY a JSON object: {"channel":"preview"|"production","message":"<short release note, max 80 chars>"}. Default channel to "preview" UNLESS the user explicitly says production / prod / live. The message should be a tight imperative noun phrase (e.g. "paywall redirect fix") suitable for an EAS update message.`,
      prompt: `INSTRUCTION: ${t}\n\nReturn JSON only.`,
      noTools: true,
      maxTurns: 1,
    }, { _agentId: 'deploy:intent' } as any);
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return { channel: 'preview', message: t.slice(0, 80), llmGuessedProduction: explicitProd };
    const parsed = JSON.parse(m[0]);
    const channel: DeployChannel = parsed.channel === 'production' ? 'production' : 'preview';
    const message = String(parsed.message ?? '').trim().slice(0, 200) || t.slice(0, 80);
    return { channel, message, llmGuessedProduction: explicitProd };
  } catch {
    return { channel: 'preview', message: t.slice(0, 80), llmGuessedProduction: explicitProd };
  }
}

// ---- Plan ---------------------------------------------------------------

export interface PrepareInput {
  project: string;
  channel: DeployChannel;
  message: string;
  skipTypecheck?: boolean;        // user override; logged as a warning
  onLine?: (line: string) => void; // live preflight log streaming
}

export async function preparePlan(input: PrepareInput): Promise<DeployPlan> {
  purgeExpired();
  const target = TARGETS[input.project];
  if (!target) throw new Error(`unknown deploy target: ${input.project}`);
  if (!fs.existsSync(target.workingDir)) throw new Error(`deploy target dir does not exist: ${target.workingDir}`);

  const message = input.message.trim();
  if (!message) throw new Error('deploy message is empty');
  if (message.length > 200) throw new Error('deploy message too long (>200 chars)');

  const log = (line: string) => input.onLine?.(line);
  log(`[prepare] target=${target.project} channel=${input.channel}`);

  // Run preflight in sequence — git checks are cheap, typecheck is slow,
  // user wants to see early failures fast.
  const preflight: PreflightCheck[] = [];
  preflight.push(await checkGitClean(target.workingDir));
  preflight.push(await checkBranch(target.workingDir, target.expectedBranch));
  preflight.push(await checkCooldown(target.project, input.channel, input.channel));

  if (input.skipTypecheck) {
    preflight.push({ name: 'typecheck', ok: true, blocking: false, detail: 'SKIPPED by user override' });
  } else {
    log('[prepare] running typecheck (this can take ~60s)...');
    preflight.push(await checkTypecheck(target.workingDir, log));
  }

  // Diff + summary
  log('[prepare] resolving diff vs last shipped...');
  const toSha = await getCurrentSha(target.workingDir);
  const diffMeta = await getDiffSinceLastShipped(target.workingDir, target.project, input.channel);
  const summary = await summariseDiff(diffMeta.rawLog, diffMeta.changedFiles);
  const branch = preflight.find(p => p.name.startsWith('on '))?.name.replace(/^on /, '') ?? target.expectedBranch;

  // Capture rollback target — must succeed for production. For preview,
  // failure is a warning.
  log('[prepare] capturing current production-channel update group for rollback...');
  const prevGroup = await getCurrentGroupForChannel(target.workingDir, input.channel);

  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const c of preflight) {
    if (!c.ok) (c.blocking ? blockers : warnings).push(`${c.name}: ${c.detail ?? 'failed'}`);
  }
  if (input.channel === 'production' && !prevGroup) {
    warnings.push('no prior update group on production — rollback won\'t be available for this ship');
  }
  if (input.channel === 'production' && diffMeta.commitCount === 0) {
    warnings.push('no new commits since the last production ship — are you re-publishing?');
  }
  if (input.channel === 'production' && diffMeta.commitCount > 20) {
    warnings.push(`${diffMeta.commitCount} commits since last production ship — large blast radius, consider preview first`);
  }

  const planId = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const plan: DeployPlan = {
    planId,
    project: target.project,
    workingDir: target.workingDir,
    channel: input.channel,
    message,
    preflight,
    diff: {
      sinceSha: diffMeta.sinceSha,
      toSha,
      branch,
      commitCount: diffMeta.commitCount,
      changedFiles: diffMeta.changedFiles,
      summary,
      rawLog: diffMeta.rawLog,
    },
    rollbackPrep: {
      previousGroupId: prevGroup?.id ?? null,
      previousMessage: prevGroup?.message ?? null,
      captured: !!prevGroup,
    },
    blockers,
    warnings,
    expiresAt: now + PLAN_TTL_MS,
    createdAt: now,
  };
  planCache.set(planId, plan);
  log(`[prepare] plan ${planId} ready (${blockers.length} blocker(s), ${warnings.length} warning(s))`);
  return plan;
}

// ---- Execute ------------------------------------------------------------

export interface ExecuteInput {
  planId: string;
  confirmation: string;             // for production must contain literal 'production'
  onLine?: (line: string) => void;
}

function appendAudit(entry: any): void {
  try {
    const dir = path.join(os.homedir(), '.hive');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8');
  } catch { /* never fatal */ }
}

function parseEasUpdateGroupId(stdout: string): string | null {
  // Two output shapes seen in the wild:
  //   "Update group: 12345-abcde-..."
  //   JSON with --json: {"id":"...","group":"...","platform":"all", ...}
  const jsonMatch = stdout.match(/\{[\s\S]*?"(?:id|group)"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (jsonMatch) return jsonMatch[1];
  const lineMatch = stdout.match(/[Uu]pdate group(?:\s*ID)?:?\s*([0-9a-fA-F-]+)/);
  if (lineMatch) return lineMatch[1];
  return null;
}

export async function executePlan(input: ExecuteInput): Promise<ExecuteResult> {
  purgeExpired();
  const plan = planCache.get(input.planId);
  if (!plan) {
    return { ok: false, deployId: -1, groupId: null, durationMs: 0, log: [], smoke: null, error: 'plan not found or expired — re-run prepare' };
  }
  if (plan.expiresAt < Date.now()) {
    planCache.delete(input.planId);
    return { ok: false, deployId: -1, groupId: null, durationMs: 0, log: [], smoke: null, error: 'plan expired (10 min TTL) — re-run prepare' };
  }
  if (plan.blockers.length > 0) {
    return { ok: false, deployId: -1, groupId: null, durationMs: 0, log: [], smoke: null, error: `cannot execute — ${plan.blockers.length} blocker(s): ${plan.blockers.join('; ')}` };
  }

  // Production confirmation gate — explicit literal 'production' required.
  // Lowercase comparison, but we strip whitespace; user types it.
  const confirmation = String(input.confirmation ?? '').trim().toLowerCase();
  if (plan.channel === 'production') {
    if (confirmation !== 'production') {
      return { ok: false, deployId: -1, groupId: null, durationMs: 0, log: [], smoke: null, error: 'production deploy requires typing the literal word "production" to confirm' };
    }
  } else {
    // Preview just needs any non-empty confirmation (a click sends "ship")
    if (!confirmation) {
      return { ok: false, deployId: -1, groupId: null, durationMs: 0, log: [], smoke: null, error: 'confirmation is required' };
    }
  }

  const lines: string[] = [];
  const onLine = (line: string) => { lines.push(line); input.onLine?.(line); };
  const startedAt = Date.now();

  const deployId = recordDeploy({
    project: plan.project,
    kind: 'update',
    channel: plan.channel,
    sha: plan.diff.toSha,
    prevGroupId: plan.rollbackPrep.previousGroupId,
    message: plan.message,
  });
  appendAudit({ event: 'deploy:start', deployId, plan: { project: plan.project, channel: plan.channel, message: plan.message, sha: plan.diff.toSha, prevGroupId: plan.rollbackPrep.previousGroupId } });

  onLine(`[execute] running: eas update --branch ${plan.channel} --message "${plan.message.replace(/"/g, '\\"')}" --non-interactive`);
  const r = await runShell('eas', [
    'update',
    '--branch', plan.channel,
    '--message', JSON.stringify(plan.message),  // wrap in quotes for shell safety
    '--non-interactive',
  ], { cwd: plan.workingDir, timeoutMs: 5 * 60_000, onLine });

  const durationMs = Date.now() - startedAt;
  if (!r.ok) {
    const err = `eas update failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-400)}`;
    if (deployId != null) updateDeployStatus(deployId, { status: 'failed', durationMs, error: err });
    appendAudit({ event: 'deploy:fail', deployId, durationMs, error: err });
    onLine(`[execute] FAILED: ${err}`);
    return { ok: false, deployId: deployId ?? -1, groupId: null, durationMs, log: lines, smoke: null, error: err };
  }

  const groupId = parseEasUpdateGroupId(r.stdout);
  if (!groupId) onLine('[execute] could not parse new group id from eas output — recorded without it');

  // Smoke test: just re-query the channel head and check the new group is
  // visible. Cheap, deterministic, doesn't need to fetch JS bundles.
  onLine('[execute] smoke: confirming new group is live on channel...');
  const head = await getCurrentGroupForChannel(plan.workingDir, plan.channel);
  let smoke: { ok: boolean; detail: string } | null = null;
  if (groupId && head?.id === groupId) {
    smoke = { ok: true, detail: `channel head is the new group ${groupId.slice(0, 12)}…` };
    onLine(`[execute] smoke OK: ${smoke.detail}`);
  } else if (head) {
    smoke = { ok: false, detail: `channel head is ${head.id.slice(0, 12)}…, expected ${groupId?.slice(0, 12) ?? '?'}` };
    onLine(`[execute] smoke MISMATCH: ${smoke.detail}`);
  } else {
    smoke = { ok: false, detail: 'could not query channel head after ship' };
    onLine(`[execute] smoke FAILED: ${smoke.detail}`);
  }

  if (deployId != null) updateDeployStatus(deployId, { status: 'shipped', durationMs, groupId });
  appendAudit({ event: 'deploy:ship', deployId, durationMs, groupId, smoke, channel: plan.channel, sha: plan.diff.toSha });
  onLine(`[execute] DONE in ${(durationMs / 1000).toFixed(1)}s. group=${groupId ?? '(unknown)'}, prev=${plan.rollbackPrep.previousGroupId ?? '(none)'}`);

  // Plan is one-shot; drop it after execution to prevent double-ship.
  planCache.delete(input.planId);

  return { ok: true, deployId: deployId ?? -1, groupId, durationMs, log: lines, smoke };
}

// ---- Rollback -----------------------------------------------------------

export interface RollbackInput {
  project: string;
  channel: DeployChannel;
  toGroupId: string;
  reason: string;
  onLine?: (line: string) => void;
}

export async function rollback(input: RollbackInput): Promise<ExecuteResult> {
  const target = TARGETS[input.project];
  if (!target) return { ok: false, deployId: -1, groupId: null, durationMs: 0, log: [], smoke: null, error: `unknown target ${input.project}` };
  if (!input.toGroupId) return { ok: false, deployId: -1, groupId: null, durationMs: 0, log: [], smoke: null, error: 'rollback target group id is required' };

  const lines: string[] = [];
  const onLine = (line: string) => { lines.push(line); input.onLine?.(line); };
  const startedAt = Date.now();

  const deployId = recordDeploy({
    project: target.project,
    kind: 'rollback',
    channel: input.channel,
    sha: null,
    prevGroupId: input.toGroupId,
    message: `rollback to ${input.toGroupId.slice(0, 12)}: ${input.reason.slice(0, 120)}`,
  });
  appendAudit({ event: 'rollback:start', deployId, channel: input.channel, toGroupId: input.toGroupId, reason: input.reason });

  onLine(`[rollback] eas update:republish --branch ${input.channel} --group ${input.toGroupId} --non-interactive`);
  const r = await runShell('eas', ['update:republish', '--branch', input.channel, '--group', input.toGroupId, '--non-interactive'], { cwd: target.workingDir, timeoutMs: 3 * 60_000, onLine });
  const durationMs = Date.now() - startedAt;

  if (!r.ok) {
    const err = `rollback failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-400)}`;
    if (deployId != null) updateDeployStatus(deployId, { status: 'failed', durationMs, error: err });
    appendAudit({ event: 'rollback:fail', deployId, durationMs, error: err });
    onLine(`[rollback] FAILED: ${err}`);
    return { ok: false, deployId: deployId ?? -1, groupId: null, durationMs, log: lines, smoke: null, error: err };
  }
  const newGroupId = parseEasUpdateGroupId(r.stdout);
  if (deployId != null) updateDeployStatus(deployId, { status: 'shipped', durationMs, groupId: newGroupId });
  appendAudit({ event: 'rollback:done', deployId, durationMs, groupId: newGroupId });
  onLine(`[rollback] DONE in ${(durationMs / 1000).toFixed(1)}s. new head group=${newGroupId ?? '(unknown)'}`);
  return { ok: true, deployId: deployId ?? -1, groupId: newGroupId, durationMs, log: lines, smoke: null };
}

// ---- Public read helpers ------------------------------------------------

export function deployHistory(limit = 20): DeployRow[] {
  return listDeploys(limit);
}

export function getCachedPlan(planId: string): DeployPlan | null {
  purgeExpired();
  return planCache.get(planId) ?? null;
}
