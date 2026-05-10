// Pulse aggregator — single source of truth for the "what's changed since
// you last opened Hive" landing strip + titlebar live chip.
//
// Pulls from systems already in Hive: deploys table, alerts table, chats
// table, brainstorm actions (renderer-stored, not main-side — so we surface
// only counts here and the renderer fills the headline). ASC is a stub
// today and will become real once the JWT-signed Apple poller lands.
//
// One getPulse() call returns a PulseSnapshot. Cached for 60s to avoid
// hammering db on a fast refresh loop.

import { listAlerts, lastDeployForChannel, listDeploys, topResumeThreads, type DeployRow, type AlertRow } from './db';

const META_LAST_OPEN = 'pulse:last_open_ts';

// ---- Types --------------------------------------------------------------

export type PulseSeverity = 'good' | 'info' | 'warning' | 'critical' | 'action' | 'muted';

export interface AppStorePulse {
  available: boolean;             // false until ASC is wired
  buildNumber: string | null;
  state: 'in-review' | 'approved' | 'rejected' | 'pending-developer-release' | 'released' | 'unknown';
  stateChangedAt: number | null;
  inStateForMs: number | null;
  detail: string;                 // headline text, e.g. "Build 42 APPROVED"
  severity: PulseSeverity;
}

export interface AlertsPulse {
  total: number;
  newSinceLastOpen: number;
  severityBreakdown: { red: number; amber: number; yellow: number; info: number };
  bySource: { github: number; sentry: number; supabase: number; asc: number };
  topAlerts: { id: number; severity: AlertRow['severity']; source: string; title: string; personaId: string | null }[];
  severity: PulseSeverity;
}

export interface ShipPulse {
  hasAny: boolean;
  lastChannel: string | null;
  lastMessage: string | null;
  lastTs: number | null;
  lastStatus: DeployRow['status'] | null;
  groupId: string | null;
  prevGroupId: string | null;
  smokeOk: boolean | null;
  rollbackAvailable: boolean;
  severity: PulseSeverity;
}

export interface ResumeThreadPulse {
  hasAny: boolean;
  personaId: string | null;
  lastQuestion: string | null;
  lastReplySnippet: string | null;
  ts: number | null;
  turnCount: number;
  severity: PulseSeverity;
}

export interface PulseSnapshot {
  ts: number;
  lastOpenTs: number | null;
  msSinceLastOpen: number | null;
  appStore: AppStorePulse;
  alerts: AlertsPulse;
  ship: ShipPulse;
  resume: ResumeThreadPulse;
  // Action tile is filled by the renderer (brainstorm actions live in
  // localStorage). We surface a placeholder count of -1 here so the renderer
  // knows to populate it client-side.
  actionsPlaceholder: { needsRendererFill: true };
  // Roll-up: if any of the above signals show "something changed since last
  // open", the strip renders in active state; otherwise it collapses.
  isAnythingNew: boolean;
  changedSummary: string;          // short sentence for the strip header
}

// ---- Cache --------------------------------------------------------------

let cached: { snap: PulseSnapshot; expires: number } | null = null;
const PULSE_TTL_MS = 60 * 1000;

export function invalidatePulse(): void {
  cached = null;
}

// ---- App Store stub -----------------------------------------------------
// Returns an unavailable AppStorePulse until the ASC poller lands. Renderer
// renders this tile as a "wire ASC API for live state" hint.

function asPulseSeverityForAsc(state: AppStorePulse['state']): PulseSeverity {
  switch (state) {
    case 'approved':
    case 'pending-developer-release': return 'good';
    case 'rejected': return 'critical';
    case 'in-review': return 'warning';
    case 'released': return 'info';
    default: return 'muted';
  }
}

function getAppStorePulse(): AppStorePulse {
  // TODO: wire ASC API once JWT signing is in. For now return a placeholder
  // so the tile appears (telling the user what they're waiting for) rather
  // than disappearing entirely.
  return {
    available: false,
    buildNumber: null,
    state: 'unknown',
    stateChangedAt: null,
    inStateForMs: null,
    detail: 'ASC poller not yet wired — manual check still needed',
    severity: 'muted',
  };
}

// ---- Alerts -------------------------------------------------------------

function getAlertsPulse(lastOpenTs: number | null): AlertsPulse {
  const open = listAlerts({ status: 'open', limit: 200 });
  const newSinceLastOpen = lastOpenTs == null
    ? open.length
    : open.filter(a => a.ts > lastOpenTs).length;

  const severityBreakdown = { red: 0, amber: 0, yellow: 0, info: 0 };
  const bySource = { github: 0, sentry: 0, supabase: 0, asc: 0 };
  for (const a of open) {
    if (a.severity in severityBreakdown) severityBreakdown[a.severity as keyof typeof severityBreakdown]++;
    if (a.source in bySource) bySource[a.source as keyof typeof bySource]++;
  }

  // Top 5: red first, then amber, then most recent
  const sorted = [...open].sort((a, b) => {
    const order = { red: 0, amber: 1, yellow: 2, info: 3 } as Record<string, number>;
    const sa = order[a.severity] ?? 9;
    const sb = order[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return b.ts - a.ts;
  });
  const topAlerts = sorted.slice(0, 5).map(a => ({
    id: a.id,
    severity: a.severity,
    source: a.source,
    title: a.title,
    personaId: a.personaId,
  }));

  let severity: PulseSeverity = 'muted';
  if (severityBreakdown.red > 0) severity = 'critical';
  else if (severityBreakdown.amber > 0) severity = 'warning';
  else if (open.length > 0) severity = 'info';
  else severity = 'good';

  return { total: open.length, newSinceLastOpen, severityBreakdown, bySource, topAlerts, severity };
}

// ---- Ship ---------------------------------------------------------------

function getShipPulse(): ShipPulse {
  const all = listDeploys(20);
  if (!all.length) {
    return {
      hasAny: false,
      lastChannel: null,
      lastMessage: null,
      lastTs: null,
      lastStatus: null,
      groupId: null,
      prevGroupId: null,
      smokeOk: null,
      rollbackAvailable: false,
      severity: 'muted',
    };
  }
  // Most recent regardless of status — failed ships are signal too
  const last = all[0];
  // smoke is recorded in the audit log but not the deploys table; we infer
  // from status (shipped + groupId = smoke implicitly OK; failed = bad)
  const smokeOk = last.status === 'shipped' ? true : (last.status === 'failed' ? false : null);
  const rollbackAvailable = last.status === 'shipped' && !!last.prevGroupId;
  let severity: PulseSeverity;
  if (last.status === 'shipped') severity = 'good';
  else if (last.status === 'failed') severity = 'critical';
  else if (last.status === 'executing') severity = 'warning';
  else severity = 'muted';

  return {
    hasAny: true,
    lastChannel: last.channel,
    lastMessage: last.message,
    lastTs: last.ts,
    lastStatus: last.status,
    groupId: last.groupId,
    prevGroupId: last.prevGroupId,
    smokeOk,
    rollbackAvailable,
    severity,
  };
}

// ---- Resume thread ------------------------------------------------------

function getResumePulse(): ResumeThreadPulse {
  const top = topResumeThreads(1);
  if (!top.length) {
    return {
      hasAny: false,
      personaId: null,
      lastQuestion: null,
      lastReplySnippet: null,
      ts: null,
      turnCount: 0,
      severity: 'muted',
    };
  }
  const t = top[0];
  return {
    hasAny: true,
    personaId: t.personaId,
    lastQuestion: t.lastQuestion,
    lastReplySnippet: t.lastReplySnippet,
    ts: t.ts,
    turnCount: t.turnCount,
    severity: 'info',
  };
}

// ---- Headline + roll-up ------------------------------------------------

function buildChangedSummary(s: PulseSnapshot, lastOpenTs: number | null): { text: string; isNew: boolean } {
  // First open: treat anything we know about as "new" — no prior baseline to
  // compare against, so the user should see the full picture, not a quiet state.
  const since = lastOpenTs ?? 0;
  const parts: string[] = [];
  if (s.alerts.newSinceLastOpen > 0) parts.push(`${s.alerts.newSinceLastOpen} new alert${s.alerts.newSinceLastOpen === 1 ? '' : 's'}`);
  if (s.ship.hasAny && (s.ship.lastTs ?? 0) > since) {
    parts.push(`${s.ship.lastChannel} deploy ${s.ship.lastStatus}`);
  }
  if (s.appStore.available && s.appStore.stateChangedAt && s.appStore.stateChangedAt > since) {
    parts.push(`Build ${s.appStore.buildNumber} → ${s.appStore.state}`);
  }
  if (s.resume.hasAny && (s.resume.ts ?? 0) > since) {
    parts.push(`new advisor reply`);
  }

  const isNew = parts.length > 0;
  if (!isNew) {
    // Quiet headline — describe state, not change
    const bits: string[] = ['All quiet'];
    if (s.ship.hasAny && s.ship.lastTs) bits.push(`last ship: ${s.ship.lastChannel} ${humanAgo(Date.now() - s.ship.lastTs)} ago`);
    if (s.alerts.total > 0) bits.push(`${s.alerts.total} open alert${s.alerts.total === 1 ? '' : 's'}`);
    return { text: bits.join(' · '), isNew: false };
  }
  return { text: parts.join(' · '), isNew: true };
}

function humanAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

// ---- Public -------------------------------------------------------------

import { getMeta, setMeta } from './db';

export function getPulse(): PulseSnapshot {
  const now = Date.now();
  if (cached && cached.expires > now) return cached.snap;

  const lastOpenStr = getMeta(META_LAST_OPEN);
  const lastOpenTs = lastOpenStr ? Number(lastOpenStr) : null;
  const msSinceLastOpen = lastOpenTs ? now - lastOpenTs : null;

  const appStore = getAppStorePulse();
  const alerts = getAlertsPulse(lastOpenTs);
  const ship = getShipPulse();
  const resume = getResumePulse();

  const partial: PulseSnapshot = {
    ts: now,
    lastOpenTs,
    msSinceLastOpen,
    appStore,
    alerts,
    ship,
    resume,
    actionsPlaceholder: { needsRendererFill: true },
    isAnythingNew: false,
    changedSummary: '',
  };
  const summary = buildChangedSummary(partial, lastOpenTs);
  partial.isAnythingNew = summary.isNew;
  partial.changedSummary = summary.text;

  cached = { snap: partial, expires: now + PULSE_TTL_MS };
  return partial;
}

// Renderer calls this when the user starts interacting (or on a manual
// "I've seen the pulse" click). Stamps last_open_ts so the next pulse
// computes "newSinceLastOpen" correctly.
export function markPulseSeen(): void {
  setMeta(META_LAST_OPEN, String(Date.now()));
  invalidatePulse();
}
