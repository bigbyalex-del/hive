// Alert ingestion — polls external sources for bugs / crashes / issues and
// stores them in the SQLite alerts table, classified to the right persona.
//
// Sources:
//   - GitHub issues (uses GITHUB_TOKEN env, polls FXV repo for bug-labelled)
//   - Sentry (uses SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT env)
//   - Supabase logs — stub for v1; needs SUPABASE_URL + SUPABASE_SERVICE_ROLE
//   - ASC (App Store Connect) — stub; needs ASC API key + JWT signing
//
// Each poller is best-effort: missing env vars → silently skip. A successful
// run inserts new alerts (deduped by source + external_id). Returns a small
// summary so the caller can log per-source counts.

import * as fs from 'fs';
import * as path from 'path';
import { insertAlert, listAlerts as dbListAlerts } from './db';

interface PersonaScopeFile {
  fxvRepoPath: string;
  claudeMemoryPath?: string;
  sharedAgentId: string;
  sharedSeedGlobs?: string[];
  personas: { id: string; isManager?: boolean; isPage?: boolean; seed_globs?: string[] }[];
}

// Cached file → persona map. Rebuilt each poll cycle so personas.json edits
// (including auto-routing additions) are honoured immediately.
function buildFileToPersona(): Map<string, string[]> {
  const personasPath = path.join(__dirname, '..', '..', 'personas.json');
  const map = new Map<string, string[]>();
  let personas: PersonaScopeFile;
  try {
    personas = JSON.parse(fs.readFileSync(personasPath, 'utf8'));
  } catch {
    return map;
  }
  for (const p of personas.personas) {
    if (!p.seed_globs) continue;
    for (const g of p.seed_globs) {
      const arr = map.get(g) ?? [];
      arr.push(p.id);
      map.set(g, arr);
    }
  }
  return map;
}

// Given a stack-trace file path, find the best persona match. Returns the
// most-specific persona id, falling back to page agents > specialists > null.
// Strategy: find any persona seed_glob that ends-with the file basename or
// that the path ends-with the glob (suffix match).
export function classifyAlertByFile(fileHint: string | null): string | null {
  if (!fileHint) return null;
  const fileToPersona = buildFileToPersona();
  // Strip leading slashes / drive letters and normalise separators.
  const norm = fileHint.replace(/\\/g, '/').replace(/^.*?\/(mobile|supabase|src|docs|site)\//, '$1/');

  // Exact-suffix match: file ends with one of the seed glob entries (or the
  // glob's basename matches the file's basename).
  const candidates = new Map<string, number>(); // personaId → match score
  for (const [glob, personaIds] of fileToPersona.entries()) {
    let score = 0;
    if (norm.endsWith(glob)) score = 10;                 // perfect tail match
    else if (norm.endsWith('/' + path.basename(glob))) score = 5;  // basename match
    if (score > 0) {
      for (const pid of personaIds) {
        candidates.set(pid, Math.max(candidates.get(pid) ?? 0, score));
      }
    }
  }
  if (candidates.size === 0) return null;

  // Prefer page agents over specialists when both match (they're more
  // file-specific).
  let best: { id: string; score: number; pageBoost: number } | null = null;
  for (const [id, score] of candidates.entries()) {
    const pageBoost = id.startsWith('fxv:page-') ? 1 : 0;
    if (!best || score + pageBoost > best.score + best.pageBoost) {
      best = { id, score, pageBoost };
    }
  }
  return best?.id ?? null;
}

// ---- GitHub poller ------------------------------------------------------

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  updated_at: string;
  labels: { name: string }[];
}

function severityFromGithubLabels(labels: string[]): 'red' | 'amber' | 'yellow' | 'info' {
  const set = new Set(labels.map(l => l.toLowerCase()));
  if (set.has('p0') || set.has('priority:critical') || set.has('crash')) return 'red';
  if (set.has('p1') || set.has('priority:high') || set.has('bug')) return 'amber';
  if (set.has('p2') || set.has('priority:medium')) return 'yellow';
  return 'info';
}

function extractFileHintFromBody(text: string | null): string | null {
  if (!text) return null;
  // Look for common patterns: "src/foo.ts:123", "mobile/src/screens/x.tsx", etc.
  const patterns = [
    /(?:mobile|supabase|src|docs|site)[\\\/][^\s)`'"<>]+\.(?:tsx?|ts|md|html|sql)/i,
    /[\w\-]+\.(?:tsx?|ts|md|html|sql)(?::\d+)?/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m) return m[0].split(':')[0]; // strip line number
  }
  return null;
}

interface PollResult {
  source: string;
  inserted: number;
  skipped: number;
  error?: string;
}

export async function pollGithub(opts: { repo?: string; label?: string } = {}): Promise<PollResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { source: 'github', inserted: 0, skipped: 0, error: 'GITHUB_TOKEN not set' };
  const repo = opts.repo ?? process.env.HIVE_ALERTS_GITHUB_REPO ?? 'bigbyalex-del/fxv-performance';
  const label = opts.label ?? process.env.HIVE_ALERTS_GITHUB_LABEL ?? 'bug';

  const url = `https://api.github.com/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=50`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        'authorization': `Bearer ${token}`,
        'accept': 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'hive-alerts',
      },
    });
  } catch (err: any) {
    return { source: 'github', inserted: 0, skipped: 0, error: err?.message ?? String(err) };
  }
  if (!resp.ok) {
    return { source: 'github', inserted: 0, skipped: 0, error: `HTTP ${resp.status}` };
  }
  const issues = await resp.json() as GitHubIssue[];
  let inserted = 0, skipped = 0;
  for (const issue of issues) {
    const labels = (issue.labels ?? []).map(l => l.name);
    const severity = severityFromGithubLabels(labels);
    const fileHint = extractFileHintFromBody(issue.body) ?? extractFileHintFromBody(issue.title);
    const personaId = classifyAlertByFile(fileHint);
    const id = insertAlert({
      source: 'github',
      externalId: `${repo}#${issue.number}`,
      severity,
      sourceTs: new Date(issue.updated_at).getTime(),
      title: issue.title,
      body: issue.body?.slice(0, 4000) ?? null,
      url: issue.html_url,
      fileHint,
      personaId,
      rawJson: { labels, number: issue.number },
    });
    if (id == null) skipped++; else inserted++;
  }
  return { source: 'github', inserted, skipped };
}

// ---- Sentry poller ------------------------------------------------------

interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  permalink: string;
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug' | string;
  status: string;
  count: string | number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  metadata?: { value?: string; type?: string; filename?: string };
}

function severityFromSentryLevel(level: string): 'red' | 'amber' | 'yellow' | 'info' {
  if (level === 'fatal') return 'red';
  if (level === 'error') return 'amber';
  if (level === 'warning') return 'yellow';
  return 'info';
}

export async function pollSentry(): Promise<PollResult> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  // Org and project accept either slug or numeric ID; SENTRY_ORG_ID +
  // SENTRY_PROJECT_ID work as a fallback for users who only have the DSN.
  const org = process.env.SENTRY_ORG ?? process.env.SENTRY_ORG_ID;
  const project = process.env.SENTRY_PROJECT ?? process.env.SENTRY_PROJECT_ID;
  if (!token || !org || !project) {
    return { source: 'sentry', inserted: 0, skipped: 0, error: 'SENTRY_AUTH_TOKEN + (SENTRY_ORG | SENTRY_ORG_ID) + (SENTRY_PROJECT | SENTRY_PROJECT_ID) required' };
  }
  // Region defaults to global sentry.io. EU users (DSN ending .de.sentry.io)
  // must call the regional host or the auth token is rejected.
  const region = (process.env.SENTRY_REGION ?? '').toLowerCase();
  const host = region === 'de' || region === 'eu' ? 'de.sentry.io' : 'sentry.io';

  const url = `https://${host}/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?statsPeriod=24h&query=is%3Aunresolved&limit=50`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        'authorization': `Bearer ${token}`,
        'accept': 'application/json',
        'user-agent': 'hive-alerts',
      },
    });
  } catch (err: any) {
    return { source: 'sentry', inserted: 0, skipped: 0, error: err?.message ?? String(err) };
  }
  if (!resp.ok) {
    return { source: 'sentry', inserted: 0, skipped: 0, error: `HTTP ${resp.status}` };
  }
  const issues = await resp.json() as SentryIssue[];
  let inserted = 0, skipped = 0;
  for (const issue of issues) {
    const fileHint = issue.metadata?.filename ?? extractFileHintFromBody(issue.culprit);
    const personaId = classifyAlertByFile(fileHint);
    const severity = severityFromSentryLevel(issue.level);
    const body = [
      issue.metadata?.value ? `Type: ${issue.metadata.type ?? '?'}\n${issue.metadata.value}` : '',
      issue.culprit ? `Culprit: ${issue.culprit}` : '',
      `Events: ${issue.count} · Users affected: ${issue.userCount}`,
      `First seen: ${issue.firstSeen} · Last seen: ${issue.lastSeen}`,
    ].filter(Boolean).join('\n');
    const id = insertAlert({
      source: 'sentry',
      externalId: issue.id,
      severity,
      sourceTs: new Date(issue.lastSeen).getTime(),
      title: issue.title,
      body,
      url: issue.permalink,
      fileHint,
      personaId,
      rawJson: { shortId: issue.shortId, level: issue.level, count: issue.count, userCount: issue.userCount },
    });
    if (id == null) skipped++; else inserted++;
  }
  return { source: 'sentry', inserted, skipped };
}

// ---- Supabase poller ---------------------------------------------------
// Hits the Supabase Management API analytics-logs endpoint with a SQL query
// for 5xx responses in edge functions over the last hour. Each row becomes
// an alert. Dedupe by Logflare's unique id field.

const SUPABASE_5XX_SQL = `
  SELECT t.id, t.timestamp, t.event_message, response.status_code AS status, request.method AS method, request.url AS url
  FROM edge_logs AS t
  CROSS JOIN UNNEST(t.metadata) AS m
  CROSS JOIN UNNEST(m.response) AS response
  CROSS JOIN UNNEST(m.request) AS request
  WHERE t.timestamp > timestamp_sub(current_timestamp(), interval 1 hour)
    AND response.status_code >= 500
  ORDER BY t.timestamp DESC
  LIMIT 50
`.replace(/\s+/g, ' ').trim();

function extractFunctionFromUrl(url: string | null): string | null {
  if (!url) return null;
  // Supabase function URLs look like:
  //   https://{ref}.supabase.co/functions/v1/<slug>?...
  const m = url.match(/\/functions\/v1\/([^?\/]+)/);
  if (m) return `supabase/functions/${m[1]}/index.ts`;
  return null;
}

export async function pollSupabase(): Promise<PollResult> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!token || !ref) {
    return { source: 'supabase', inserted: 0, skipped: 0, error: 'SUPABASE_ACCESS_TOKEN/SUPABASE_PROJECT_REF not set' };
  }

  const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/analytics/endpoints/logs.all?sql=${encodeURIComponent(SUPABASE_5XX_SQL)}`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        'authorization': `Bearer ${token}`,
        'accept': 'application/json',
        'user-agent': 'hive-alerts',
      },
    });
  } catch (err: any) {
    return { source: 'supabase', inserted: 0, skipped: 0, error: err?.message ?? String(err) };
  }
  if (!resp.ok) {
    const body = await resp.text();
    return { source: 'supabase', inserted: 0, skipped: 0, error: `HTTP ${resp.status}: ${body.slice(0, 120)}` };
  }
  const json: any = await resp.json();
  if (json.error) {
    return { source: 'supabase', inserted: 0, skipped: 0, error: typeof json.error === 'string' ? json.error : JSON.stringify(json.error).slice(0, 120) };
  }
  const rows: any[] = Array.isArray(json.result) ? json.result : [];

  let inserted = 0, skipped = 0;
  for (const row of rows) {
    const fileHint = extractFunctionFromUrl(row.url);
    const personaId = classifyAlertByFile(fileHint);
    const status = Number(row.status) || 500;
    const method = String(row.method || '').toUpperCase();
    const fnName = fileHint ? fileHint.split('/').slice(-2)[0] : null;
    const title = fnName
      ? `[${status}] ${method} ${fnName}`
      : `[${status}] ${method} ${(row.url || 'edge fn').slice(0, 80)}`;
    const body = [
      `Status: ${status} · Method: ${method}`,
      row.url ? `URL: ${row.url}` : '',
      row.event_message ? `Message:\n${row.event_message}` : '',
    ].filter(Boolean).join('\n');
    const id = insertAlert({
      source: 'supabase',
      externalId: String(row.id),
      severity: status >= 500 ? 'red' : 'amber',
      sourceTs: row.timestamp ? Number(row.timestamp) / 1000 : null, // bigquery returns microseconds
      title,
      body,
      url: `https://supabase.com/dashboard/project/${ref}/functions/${fnName ?? ''}/logs`,
      fileHint,
      personaId,
      rawJson: { status, method, url: row.url },
    });
    if (id == null) skipped++; else inserted++;
  }
  return { source: 'supabase', inserted, skipped };
}

// ---- ASC poller (stub) --------------------------------------------------
// Needs JWT signing with the .p8 private key. Wire when the rest is humming.
export async function pollAsc(): Promise<PollResult> {
  if (!process.env.ASC_KEY_ID || !process.env.ASC_ISSUER_ID || !process.env.ASC_PRIVATE_KEY_PATH) {
    return { source: 'asc', inserted: 0, skipped: 0, error: 'ASC_KEY_ID/ASC_ISSUER_ID/ASC_PRIVATE_KEY_PATH not set' };
  }
  return { source: 'asc', inserted: 0, skipped: 0, error: 'not yet implemented' };
}

// ---- Orchestrator -------------------------------------------------------

export type AlertNotifier = (evt: { type: 'poll-result'; result: PollResult } | { type: 'new-alerts'; count: number; alertIds: number[] }) => void;

let pollTimer: NodeJS.Timeout | null = null;
let isPolling = false;

export async function pollAllOnce(notify?: AlertNotifier): Promise<PollResult[]> {
  if (isPolling) return [];
  isPolling = true;
  try {
    const results = await Promise.all([
      pollGithub().catch(err => ({ source: 'github', inserted: 0, skipped: 0, error: String(err) } as PollResult)),
      pollSentry().catch(err => ({ source: 'sentry', inserted: 0, skipped: 0, error: String(err) } as PollResult)),
      pollSupabase().catch(err => ({ source: 'supabase', inserted: 0, skipped: 0, error: String(err) } as PollResult)),
      // ASC skipped from default loop until wired
    ]);
    let totalNew = 0;
    for (const r of results) {
      notify?.({ type: 'poll-result', result: r });
      totalNew += r.inserted;
    }
    if (totalNew > 0 && notify) {
      const recent = dbListAlerts({ status: 'new', limit: 50 }).slice(0, totalNew);
      notify({ type: 'new-alerts', count: totalNew, alertIds: recent.map(a => a.id) });
    }
    return results;
  } finally {
    isPolling = false;
  }
}

export function startAlertsPolling(intervalMs: number, notify?: AlertNotifier): void {
  if (pollTimer) return;
  // Fire one immediately so the user sees alerts on launch.
  pollAllOnce(notify).catch(err => console.warn('[alerts] initial poll failed:', err));
  pollTimer = setInterval(() => {
    pollAllOnce(notify).catch(err => console.warn('[alerts] poll failed:', err));
  }, intervalMs);
}

export function stopAlertsPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Expose enabled-source detection so the UI can show which pollers are live.
export function alertsConfig() {
  return {
    github: !!process.env.GITHUB_TOKEN,
    sentry: !!(
      process.env.SENTRY_AUTH_TOKEN &&
      (process.env.SENTRY_ORG || process.env.SENTRY_ORG_ID) &&
      (process.env.SENTRY_PROJECT || process.env.SENTRY_PROJECT_ID)
    ),
    supabase: !!(process.env.SUPABASE_ACCESS_TOKEN && process.env.SUPABASE_PROJECT_REF),
    asc: !!(process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID && process.env.ASC_PRIVATE_KEY_PATH),
    githubRepo: process.env.HIVE_ALERTS_GITHUB_REPO ?? 'bigbyalex-del/fxv-performance',
    githubLabel: process.env.HIVE_ALERTS_GITHUB_LABEL ?? 'bug',
  };
}
