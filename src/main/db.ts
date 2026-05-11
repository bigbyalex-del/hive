// Hive's persistent state — pure-JS SQLite via sql.js (no native compile).
//
// Stored at ~/.hive/state.sqlite. Two tables for now:
//   dispatches — every Manager decompose call (user input + subtasks + cost)
//   runs       — every Worker execution (model, tokens, cost, timing, status)
//
// Manager loads recent dispatches on startup so chat memory ("how's the site?")
// survives restart. Tomorrow's autonomous-colleague work uses the same store
// for goal queue + persistent transcripts.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

let db: any = null;
let dbPath: string = '';
let saveTimer: NodeJS.Timeout | null = null;

function getDbPath(): string {
  if (dbPath) return dbPath;
  const dir = path.join(os.homedir(), '.hive');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  dbPath = path.join(dir, 'state.sqlite');
  return dbPath;
}

export async function initDb(): Promise<void> {
  if (db) return;
  const initSqlJs = (await dynamicImport('sql.js')).default ?? (await dynamicImport('sql.js'));
  const SQL = await initSqlJs({
    // sql.js blocks require.resolve on its package.json, so we resolve via
    // its main entry then derive the dist dir from there.
    locateFile: (file: string) => {
      try {
        const entry = require.resolve('sql.js');
        return path.join(path.dirname(entry), file);
      } catch {
        // Fallback: assume node_modules layout next to the project.
        return path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file);
      }
    },
  });

  const file = getDbPath();
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_input TEXT NOT NULL,
      subtasks_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatches_ts ON dispatches(ts);

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id INTEGER,
      ts INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      status TEXT,
      summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_dispatch ON runs(dispatch_id);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      tag TEXT,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_agent ON chunks(agent_id);

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      dir TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      ts INTEGER NOT NULL,
      source_ts INTEGER,
      title TEXT NOT NULL,
      body TEXT,
      url TEXT,
      file_hint TEXT,
      persona_id TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      raw_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_ext ON alerts(source, external_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);

    CREATE TABLE IF NOT EXISTS deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      channel TEXT NOT NULL,
      sha TEXT,
      group_id TEXT,
      prev_group_id TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deploys_ts ON deploys(ts);
    CREATE INDEX IF NOT EXISTS idx_deploys_channel ON deploys(channel, ts);

    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      persona_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sources_json TEXT,
      project_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chats_persona_ts ON chats(persona_id, ts);
    CREATE INDEX IF NOT EXISTS idx_chats_ts ON chats(ts);

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      persona_id TEXT,
      project_id INTEGER,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      source_chat_id INTEGER,
      source_question TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_actions_project ON actions(project_id, status);
  `);

  // Lightweight migrations — sql.js doesn't fail on duplicate ALTER, but we
  // gate via a column-existence check so old DBs gain project_id without
  // breaking new ones.
  ensureColumn('dispatches', 'project_id', 'INTEGER');
  ensureColumn('runs', 'project_id', 'INTEGER');
  ensureColumn('chunks', 'project_id', 'INTEGER');

  // Seed a default project the first time we boot. The existing
  // worktrees/project/ directory becomes project #1 so prior history doesn't
  // strand. Subsequent projects live at worktrees/projects/<slug>/.
  const existing = db.exec('SELECT COUNT(*) FROM projects')[0]?.values?.[0]?.[0] ?? 0;
  if (existing === 0) {
    const ts = Date.now();
    const stmt = db.prepare('INSERT INTO projects (slug, name, dir, created_at, last_used) VALUES (?, ?, ?, ?, ?)');
    stmt.run(['default', 'Default', 'worktrees/project', ts, ts]);
    stmt.free();
    // Backfill project_id=1 on any pre-existing rows so memory + history
    // remain visible after the migration.
    db.run('UPDATE dispatches SET project_id = 1 WHERE project_id IS NULL');
    db.run('UPDATE runs SET project_id = 1 WHERE project_id IS NULL');
    db.run('UPDATE chunks SET project_id = 1 WHERE project_id IS NULL');
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('active_project_id', '1')");
  }

  console.log(`[hive] db ready at ${file}`);
}

function ensureColumn(table: string, column: string, type: string): void {
  if (!db) return;
  try {
    const info = db.exec(`PRAGMA table_info(${table})`);
    const cols = info[0]?.values?.map((r: any[]) => r[1]) ?? [];
    if (!cols.includes(column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  } catch (err) {
    console.warn(`[hive] ensureColumn ${table}.${column} failed:`, err);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 1500); // debounce writes
}

export function persistNow(): void {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(getDbPath(), Buffer.from(data));
  } catch (err) {
    console.error('[hive] db save failed:', err);
  }
}

export function recordDispatch(userInput: string, subtasks: { task: string; model?: string }[], projectId?: number | null): number | null {
  if (!db) return null;
  const ts = Date.now();
  const stmt = db.prepare('INSERT INTO dispatches (ts, user_input, subtasks_json, project_id) VALUES (?, ?, ?, ?)');
  stmt.run([ts, userInput, JSON.stringify(subtasks), projectId ?? null]);
  stmt.free();
  const idResult = db.exec('SELECT last_insert_rowid() AS id');
  const id = idResult[0]?.values?.[0]?.[0] as number | undefined;
  scheduleSave();
  return typeof id === 'number' ? id : null;
}

export function recordRun(opts: {
  dispatchId: number | null;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  status: 'done' | 'error' | 'cancelled';
  summary?: string;
  projectId?: number | null;
}): void {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO runs (dispatch_id, ts, agent_id, model, input_tokens, output_tokens, status, summary, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    opts.dispatchId,
    Date.now(),
    opts.agentId,
    opts.model,
    opts.inputTokens,
    opts.outputTokens,
    opts.status,
    opts.summary ?? null,
    opts.projectId ?? null,
  ]);
  stmt.free();
  scheduleSave();
}

export function loadRecentDispatches(limit = 20, projectId?: number | null): { userInput: string; subtasks: { task: string; model?: string }[]; timestamp: number }[] {
  if (!db) return [];
  let result;
  if (projectId == null) {
    result = db.exec(`SELECT ts, user_input, subtasks_json FROM dispatches ORDER BY ts DESC LIMIT ${limit}`);
  } else {
    const stmt = db.prepare('SELECT ts, user_input, subtasks_json FROM dispatches WHERE project_id = ? ORDER BY ts DESC LIMIT ?');
    stmt.bind([projectId, limit]);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.get());
    stmt.free();
    if (rows.length === 0) return [];
    return rows.map(r => ({ timestamp: r[0], userInput: r[1], subtasks: JSON.parse(r[2]) })).reverse();
  }
  if (!result.length) return [];
  return result[0].values
    .map((row: any[]) => ({
      timestamp: row[0],
      userInput: row[1],
      subtasks: JSON.parse(row[2]),
    }))
    .reverse(); // chronological order
}

export function getTotalTokens(): { input: number; output: number; cost: number } {
  if (!db) return { input: 0, output: 0, cost: 0 };
  const r = db.exec('SELECT SUM(input_tokens), SUM(output_tokens) FROM runs');
  if (!r.length) return { input: 0, output: 0, cost: 0 };
  const [input, output] = r[0].values[0];
  return {
    input: input ?? 0,
    output: output ?? 0,
    cost: 0, // wired up properly when we model per-model pricing
  };
}

// Aggregate runs grouped by model so caller can multiply tokens × per-model
// pricing. Optional projectId scopes the aggregate; sinceTs scopes by time
// (e.g. start-of-day for "today's spend").
export function aggregateRuns(opts: { projectId?: number | null; sinceTs?: number } = {}): { model: string; inputTokens: number; outputTokens: number; runs: number }[] {
  if (!db) return [];
  const where: string[] = [];
  const args: any[] = [];
  if (opts.projectId != null) { where.push('project_id = ?'); args.push(opts.projectId); }
  if (opts.sinceTs != null) { where.push('ts >= ?'); args.push(opts.sinceTs); }
  const sql = `SELECT model, SUM(input_tokens), SUM(output_tokens), COUNT(*) FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY model`;
  const stmt = db.prepare(sql);
  if (args.length) stmt.bind(args);
  const out: { model: string; inputTokens: number; outputTokens: number; runs: number }[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    out.push({ model: String(row[0] ?? ''), inputTokens: Number(row[1] ?? 0), outputTokens: Number(row[2] ?? 0), runs: Number(row[3] ?? 0) });
  }
  stmt.free();
  return out;
}

export function insertChunk(opts: { agentId: string; tag?: string; content: string; embedding: number[]; projectId?: number | null }): number | null {
  if (!db) return null;
  const stmt = db.prepare('INSERT INTO chunks (ts, agent_id, tag, content, embedding, project_id) VALUES (?, ?, ?, ?, ?, ?)');
  stmt.run([Date.now(), opts.agentId, opts.tag ?? null, opts.content, JSON.stringify(opts.embedding), opts.projectId ?? null]);
  stmt.free();
  const r = db.exec('SELECT last_insert_rowid() AS id');
  const id = r[0]?.values?.[0]?.[0] as number | undefined;
  scheduleSave();
  return typeof id === 'number' ? id : null;
}

// Drops every chunk owned by an agent across all projects. Used by the
// advisor seed script to reset a persona's knowledge before re-ingesting,
// so seeds are idempotent rather than additive.
export function deleteChunksForAgent(agentId: string): number {
  if (!db) return 0;
  const stmt = db.prepare('DELETE FROM chunks WHERE agent_id = ?');
  stmt.bind([agentId]);
  stmt.step();
  stmt.free();
  const r = db.exec('SELECT changes()');
  const n = r[0]?.values?.[0]?.[0] as number | undefined;
  scheduleSave();
  return typeof n === 'number' ? n : 0;
}

export function countChunksForAgent(agentId: string): number {
  if (!db) return 0;
  const stmt = db.prepare('SELECT COUNT(*) FROM chunks WHERE agent_id = ?');
  stmt.bind([agentId]);
  stmt.step();
  const row = stmt.get();
  stmt.free();
  return Number(row[0] ?? 0);
}

export function loadChunks(agentId: string, projectId?: number | null): { id: number; tag: string | null; content: string; embedding: number[] }[] {
  if (!db) return [];
  const stmt = projectId == null
    ? db.prepare('SELECT id, tag, content, embedding FROM chunks WHERE agent_id = ?')
    : db.prepare('SELECT id, tag, content, embedding FROM chunks WHERE agent_id = ? AND project_id = ?');
  if (projectId == null) stmt.bind([agentId]); else stmt.bind([agentId, projectId]);
  const out: any[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    out.push({ id: row[0], tag: row[1], content: row[2], embedding: JSON.parse(row[3]) });
  }
  stmt.free();
  return out;
}

// ---- Alerts -----------------------------------------------------------
//
// Each alert is a single bug / crash / production issue routed to the right
// persona. Dedupe is per (source, external_id) so re-polling the same Sentry
// issue doesn't create duplicates.

export interface AlertRow {
  id: number;
  source: string;          // 'github' | 'sentry' | 'supabase' | 'asc'
  externalId: string;
  severity: 'red' | 'amber' | 'yellow' | 'info';
  ts: number;
  sourceTs: number | null;
  title: string;
  body: string | null;
  url: string | null;
  fileHint: string | null;
  personaId: string | null;
  status: 'new' | 'seen' | 'acked' | 'dismissed';
  rawJson: string | null;
}

export interface InsertAlertOpts {
  source: string;
  externalId: string;
  severity: AlertRow['severity'];
  sourceTs?: number | null;
  title: string;
  body?: string | null;
  url?: string | null;
  fileHint?: string | null;
  personaId?: string | null;
  rawJson?: any;
}

// Returns the inserted alert id, or null if (source, external_id) already
// exists. Caller can treat null as "already seen, skip".
export function insertAlert(opts: InsertAlertOpts): number | null {
  if (!db) return null;
  // Dedupe check.
  const dupCheck = db.prepare('SELECT id FROM alerts WHERE source = ? AND external_id = ?');
  dupCheck.bind([opts.source, opts.externalId]);
  if (dupCheck.step()) {
    dupCheck.free();
    return null;
  }
  dupCheck.free();
  const stmt = db.prepare(`
    INSERT INTO alerts (source, external_id, severity, ts, source_ts, title, body, url, file_hint, persona_id, status, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `);
  stmt.run([
    opts.source,
    opts.externalId,
    opts.severity,
    Date.now(),
    opts.sourceTs ?? null,
    opts.title,
    opts.body ?? null,
    opts.url ?? null,
    opts.fileHint ?? null,
    opts.personaId ?? null,
    opts.rawJson ? JSON.stringify(opts.rawJson) : null,
  ]);
  stmt.free();
  const r = db.exec('SELECT last_insert_rowid()');
  const id = r[0]?.values?.[0]?.[0] as number | undefined;
  scheduleSave();
  return typeof id === 'number' ? id : null;
}

export function listAlerts(opts: { status?: AlertRow['status'] | 'open' | 'all'; limit?: number } = {}): AlertRow[] {
  if (!db) return [];
  let where = '';
  const args: any[] = [];
  const status = opts.status ?? 'open';
  if (status === 'open') { where = "WHERE status IN ('new','seen')"; }
  else if (status !== 'all') { where = 'WHERE status = ?'; args.push(status); }
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const sql = `SELECT id, source, external_id, severity, ts, source_ts, title, body, url, file_hint, persona_id, status, raw_json FROM alerts ${where} ORDER BY ts DESC LIMIT ${limit}`;
  const stmt = db.prepare(sql);
  if (args.length) stmt.bind(args);
  const out: AlertRow[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    out.push({
      id: row[0] as number,
      source: row[1] as string,
      externalId: row[2] as string,
      severity: row[3] as AlertRow['severity'],
      ts: row[4] as number,
      sourceTs: (row[5] ?? null) as number | null,
      title: row[6] as string,
      body: (row[7] ?? null) as string | null,
      url: (row[8] ?? null) as string | null,
      fileHint: (row[9] ?? null) as string | null,
      personaId: (row[10] ?? null) as string | null,
      status: row[11] as AlertRow['status'],
      rawJson: (row[12] ?? null) as string | null,
    });
  }
  stmt.free();
  return out;
}

export function setAlertStatus(id: number, status: AlertRow['status']): void {
  if (!db) return;
  const stmt = db.prepare('UPDATE alerts SET status = ? WHERE id = ?');
  stmt.run([status, id]);
  stmt.free();
  scheduleSave();
}

export function deleteAlertRow(id: number): void {
  if (!db) return;
  const stmt = db.prepare('DELETE FROM alerts WHERE id = ?');
  stmt.run([id]);
  stmt.free();
  scheduleSave();
}

// ---- Actions ----------------------------------------------------------
//
// Concrete to-dos extracted from advisor replies (extractActions in
// advisors.ts) plus anything Alex creates manually from the Linear-style
// Actions view. status lifecycle: todo → in_progress → in_review → done
// (or → blocked at any point). priority is urgent/high/medium/low.

export type ActionStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked';
export type ActionPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface ActionRow {
  id: number;
  ts: number;
  updatedAt: number;
  personaId: string | null;
  projectId: number | null;
  content: string;
  status: ActionStatus;
  priority: ActionPriority;
  sourceChatId: number | null;
  sourceQuestion: string | null;
}

export interface InsertActionOpts {
  content: string;
  personaId?: string | null;
  projectId?: number | null;
  priority?: ActionPriority;
  status?: ActionStatus;
  sourceChatId?: number | null;
  sourceQuestion?: string | null;
}

export function insertAction(opts: InsertActionOpts): number | null {
  if (!db) return null;
  const ts = Date.now();
  const stmt = db.prepare(`
    INSERT INTO actions (ts, updated_at, persona_id, project_id, content, status, priority, source_chat_id, source_question)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    ts,
    ts,
    opts.personaId ?? null,
    opts.projectId ?? null,
    opts.content,
    opts.status ?? 'todo',
    opts.priority ?? 'medium',
    opts.sourceChatId ?? null,
    opts.sourceQuestion ?? null,
  ]);
  stmt.free();
  const idResult = db.exec('SELECT last_insert_rowid() AS id');
  const id = idResult[0]?.values?.[0]?.[0] as number | undefined;
  scheduleSave();
  return typeof id === 'number' ? id : null;
}

function rowToAction(row: any[]): ActionRow {
  return {
    id: row[0] as number,
    ts: row[1] as number,
    updatedAt: row[2] as number,
    personaId: (row[3] ?? null) as string | null,
    projectId: (row[4] ?? null) as number | null,
    content: row[5] as string,
    status: row[6] as ActionStatus,
    priority: row[7] as ActionPriority,
    sourceChatId: (row[8] ?? null) as number | null,
    sourceQuestion: (row[9] ?? null) as string | null,
  };
}

export function listActions(opts: { status?: ActionStatus | 'active' | 'all'; projectId?: number | null; limit?: number } = {}): ActionRow[] {
  if (!db) return [];
  const status = opts.status ?? 'active';
  const args: any[] = [];
  const where: string[] = [];
  if (status === 'active') { where.push("status IN ('todo','in_progress','in_review','blocked')"); }
  else if (status !== 'all') { where.push('status = ?'); args.push(status); }
  if (opts.projectId != null) { where.push('project_id = ?'); args.push(opts.projectId); }
  const sql = `SELECT id, ts, updated_at, persona_id, project_id, content, status, priority, source_chat_id, source_question
               FROM actions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(500, opts.limit ?? 200))}`;
  const stmt = db.prepare(sql);
  if (args.length) stmt.bind(args);
  const out: ActionRow[] = [];
  while (stmt.step()) out.push(rowToAction(stmt.get()));
  stmt.free();
  return out;
}

export function getAction(id: number): ActionRow | null {
  if (!db) return null;
  const stmt = db.prepare(`SELECT id, ts, updated_at, persona_id, project_id, content, status, priority, source_chat_id, source_question FROM actions WHERE id = ?`);
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = rowToAction(stmt.get());
  stmt.free();
  return row;
}

export function updateAction(id: number, patch: Partial<Pick<ActionRow, 'content' | 'status' | 'priority' | 'personaId' | 'projectId'>>): void {
  if (!db) return;
  const fields: string[] = [];
  const args: any[] = [];
  if (patch.content !== undefined) { fields.push('content = ?'); args.push(patch.content); }
  if (patch.status !== undefined) { fields.push('status = ?'); args.push(patch.status); }
  if (patch.priority !== undefined) { fields.push('priority = ?'); args.push(patch.priority); }
  if (patch.personaId !== undefined) { fields.push('persona_id = ?'); args.push(patch.personaId); }
  if (patch.projectId !== undefined) { fields.push('project_id = ?'); args.push(patch.projectId); }
  if (!fields.length) return;
  fields.push('updated_at = ?'); args.push(Date.now());
  args.push(id);
  const stmt = db.prepare(`UPDATE actions SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(args);
  stmt.free();
  scheduleSave();
}

export function deleteAction(id: number): void {
  if (!db) return;
  const stmt = db.prepare('DELETE FROM actions WHERE id = ?');
  stmt.run([id]);
  stmt.free();
  scheduleSave();
}

// ---- Deploys ----------------------------------------------------------
//
// Audit trail of every OTA / build / submit Hive has driven. Status flows
// new → executing → shipped | failed | cancelled. group_id is the EAS
// update group (for OTAs) or build id (for builds). prev_group_id is what
// 'rollback' republishes.

export interface DeployRow {
  id: number;
  ts: number;
  project: string;
  kind: 'update' | 'build' | 'submit' | 'rollback';
  channel: string;
  sha: string | null;
  groupId: string | null;
  prevGroupId: string | null;
  message: string;
  status: 'executing' | 'shipped' | 'failed' | 'cancelled';
  durationMs: number | null;
  error: string | null;
}

export interface InsertDeployOpts {
  project: string;
  kind: DeployRow['kind'];
  channel: string;
  sha?: string | null;
  prevGroupId?: string | null;
  message: string;
}

export function recordDeploy(opts: InsertDeployOpts): number | null {
  if (!db) return null;
  const stmt = db.prepare(`
    INSERT INTO deploys (ts, project, kind, channel, sha, prev_group_id, message, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'executing')
  `);
  stmt.run([
    Date.now(),
    opts.project,
    opts.kind,
    opts.channel,
    opts.sha ?? null,
    opts.prevGroupId ?? null,
    opts.message,
  ]);
  stmt.free();
  const r = db.exec('SELECT last_insert_rowid()');
  const id = r[0]?.values?.[0]?.[0] as number | undefined;
  scheduleSave();
  return typeof id === 'number' ? id : null;
}

export function updateDeployStatus(id: number, opts: { status: DeployRow['status']; groupId?: string | null; durationMs?: number | null; error?: string | null }): void {
  if (!db) return;
  const stmt = db.prepare(`
    UPDATE deploys
    SET status = ?,
        group_id = COALESCE(?, group_id),
        duration_ms = COALESCE(?, duration_ms),
        error = COALESCE(?, error)
    WHERE id = ?
  `);
  stmt.run([
    opts.status,
    opts.groupId ?? null,
    opts.durationMs ?? null,
    opts.error ?? null,
    id,
  ]);
  stmt.free();
  scheduleSave();
}

// Used for cooldown enforcement: returns the most recent shipped deploy on
// (project, channel) regardless of kind. null = no prior deploy.
export function lastDeployForChannel(project: string, channel: string): DeployRow | null {
  if (!db) return null;
  const stmt = db.prepare(`
    SELECT id, ts, project, kind, channel, sha, group_id, prev_group_id, message, status, duration_ms, error
    FROM deploys
    WHERE project = ? AND channel = ? AND status = 'shipped'
    ORDER BY ts DESC LIMIT 1
  `);
  stmt.bind([project, channel]);
  if (!stmt.step()) { stmt.free(); return null; }
  const r = stmt.get();
  stmt.free();
  return {
    id: r[0] as number,
    ts: r[1] as number,
    project: r[2] as string,
    kind: r[3] as DeployRow['kind'],
    channel: r[4] as string,
    sha: (r[5] ?? null) as string | null,
    groupId: (r[6] ?? null) as string | null,
    prevGroupId: (r[7] ?? null) as string | null,
    message: r[8] as string,
    status: r[9] as DeployRow['status'],
    durationMs: (r[10] ?? null) as number | null,
    error: (r[11] ?? null) as string | null,
  };
}

export function listDeploys(limit = 20): DeployRow[] {
  if (!db) return [];
  const stmt = db.prepare(`
    SELECT id, ts, project, kind, channel, sha, group_id, prev_group_id, message, status, duration_ms, error
    FROM deploys ORDER BY ts DESC LIMIT ?
  `);
  stmt.bind([Math.max(1, Math.min(200, limit))]);
  const out: DeployRow[] = [];
  while (stmt.step()) {
    const r = stmt.get();
    out.push({
      id: r[0] as number,
      ts: r[1] as number,
      project: r[2] as string,
      kind: r[3] as DeployRow['kind'],
      channel: r[4] as string,
      sha: (r[5] ?? null) as string | null,
      groupId: (r[6] ?? null) as string | null,
      prevGroupId: (r[7] ?? null) as string | null,
      message: r[8] as string,
      status: r[9] as DeployRow['status'],
      durationMs: (r[10] ?? null) as number | null,
      error: (r[11] ?? null) as string | null,
    });
  }
  stmt.free();
  return out;
}

// ---- Chats ------------------------------------------------------------
//
// Persisted advisor conversations. Each turn is one row. Powers cell
// previews, "resume thread" pulse tile, and lets advisor histories
// survive restart instead of evaporating from a renderer Map.

export interface ChatRow {
  id: number;
  ts: number;
  personaId: string;
  role: 'user' | 'assistant';
  content: string;
  sources: { index: number; label: string; score: number }[] | null;
  projectId: number | null;
}

export function insertChat(opts: { personaId: string; role: 'user' | 'assistant'; content: string; sources?: { index: number; label: string; score: number }[] | null; projectId?: number | null }): number | null {
  if (!db) return null;
  const stmt = db.prepare('INSERT INTO chats (ts, persona_id, role, content, sources_json, project_id) VALUES (?, ?, ?, ?, ?, ?)');
  stmt.run([
    Date.now(),
    opts.personaId,
    opts.role,
    opts.content,
    opts.sources ? JSON.stringify(opts.sources) : null,
    opts.projectId ?? null,
  ]);
  stmt.free();
  const r = db.exec('SELECT last_insert_rowid()');
  const id = r[0]?.values?.[0]?.[0] as number | undefined;
  scheduleSave();
  return typeof id === 'number' ? id : null;
}

function rowToChat(r: any[]): ChatRow {
  const sourcesRaw = r[5] as string | null;
  let sources: ChatRow['sources'] = null;
  if (sourcesRaw) {
    try { sources = JSON.parse(sourcesRaw); } catch { sources = null; }
  }
  return {
    id: r[0] as number,
    ts: r[1] as number,
    personaId: r[2] as string,
    role: r[3] as ChatRow['role'],
    content: r[4] as string,
    sources,
    projectId: (r[6] ?? null) as number | null,
  };
}

export function listChatsForPersona(personaId: string, limit = 100): ChatRow[] {
  if (!db) return [];
  const stmt = db.prepare('SELECT id, ts, persona_id, role, content, sources_json, project_id FROM chats WHERE persona_id = ? ORDER BY ts ASC LIMIT ?');
  stmt.bind([personaId, Math.max(1, Math.min(500, limit))]);
  const out: ChatRow[] = [];
  while (stmt.step()) out.push(rowToChat(stmt.get()));
  stmt.free();
  return out;
}

// One-row-per-persona summary for cell previews. Returns the most recent
// assistant reply per persona along with the question that triggered it
// and the turn count. Designed to be called once on render, not per-cell.
export interface PersonaPreview {
  personaId: string;
  lastAssistant: { ts: number; content: string } | null;
  lastUserQuestion: string | null;
  turnCount: number;        // user-turn count (assistant replies)
}
export function previewByPersona(personaIds: string[]): Record<string, PersonaPreview> {
  const out: Record<string, PersonaPreview> = {};
  if (!db) return out;
  for (const pid of personaIds) {
    const stmt = db.prepare("SELECT COUNT(*) FROM chats WHERE persona_id = ? AND role = 'assistant'");
    stmt.bind([pid]); stmt.step();
    const turnCount = Number(stmt.get()[0] ?? 0);
    stmt.free();

    const lastAsst = db.prepare("SELECT ts, content FROM chats WHERE persona_id = ? AND role = 'assistant' ORDER BY ts DESC LIMIT 1");
    lastAsst.bind([pid]);
    let last: PersonaPreview['lastAssistant'] = null;
    if (lastAsst.step()) {
      const r = lastAsst.get();
      last = { ts: r[0] as number, content: r[1] as string };
    }
    lastAsst.free();

    let lastQ: string | null = null;
    if (last) {
      const lastUser = db.prepare("SELECT content FROM chats WHERE persona_id = ? AND role = 'user' AND ts <= ? ORDER BY ts DESC LIMIT 1");
      lastUser.bind([pid, last.ts]);
      if (lastUser.step()) lastQ = String(lastUser.get()[0] ?? '');
      lastUser.free();
    }

    out[pid] = { personaId: pid, lastAssistant: last, lastUserQuestion: lastQ, turnCount };
  }
  return out;
}

// Top N "resume threads" across all personas — most-recently-active first.
// Used by the pulse strip's resume tile.
export interface ResumeThread {
  personaId: string;
  ts: number;
  lastQuestion: string;
  lastReplySnippet: string;
  turnCount: number;
}
export function topResumeThreads(limit = 5): ResumeThread[] {
  if (!db) return [];
  const stmt = db.prepare(`
    SELECT persona_id, MAX(ts) AS last_ts
    FROM chats
    WHERE role = 'assistant'
    GROUP BY persona_id
    ORDER BY last_ts DESC
    LIMIT ?
  `);
  stmt.bind([Math.max(1, Math.min(20, limit))]);
  const heads: { personaId: string; ts: number }[] = [];
  while (stmt.step()) {
    const r = stmt.get();
    heads.push({ personaId: r[0] as string, ts: r[1] as number });
  }
  stmt.free();

  const out: ResumeThread[] = [];
  for (const h of heads) {
    const reply = db.prepare("SELECT content FROM chats WHERE persona_id = ? AND role = 'assistant' AND ts = ? LIMIT 1");
    reply.bind([h.personaId, h.ts]);
    const replyContent = reply.step() ? String(reply.get()[0] ?? '') : '';
    reply.free();

    const q = db.prepare("SELECT content FROM chats WHERE persona_id = ? AND role = 'user' AND ts <= ? ORDER BY ts DESC LIMIT 1");
    q.bind([h.personaId, h.ts]);
    const qContent = q.step() ? String(q.get()[0] ?? '') : '';
    q.free();

    const tc = db.prepare("SELECT COUNT(*) FROM chats WHERE persona_id = ? AND role = 'assistant'");
    tc.bind([h.personaId]); tc.step();
    const turns = Number(tc.get()[0] ?? 0);
    tc.free();

    out.push({
      personaId: h.personaId,
      ts: h.ts,
      lastQuestion: qContent,
      lastReplySnippet: replyContent.length > 220 ? replyContent.slice(0, 220) + '…' : replyContent,
      turnCount: turns,
    });
  }
  return out;
}

// ---- Meta key/value helpers --------------------------------------------
// Generic key/value store backed by the `meta` table. Used by pulse for
// last-open timestamps and any other small string-typed config that
// benefits from surviving restart without a dedicated column.
export function getMeta(key: string): string | null {
  if (!db) return null;
  const stmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  stmt.bind([key]);
  if (!stmt.step()) { stmt.free(); return null; }
  const r = stmt.get();
  stmt.free();
  return typeof r[0] === 'string' ? r[0] : null;
}
export function setMeta(key: string, value: string): void {
  if (!db) return;
  const stmt = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  stmt.run([key, value]);
  stmt.free();
  scheduleSave();
}

// On boot, mark any 'executing' deploys older than 10 min as 'failed' with
// a recovery hint — they're stuck because the app crashed mid-run.
export function reconcileStuckDeploys(): number {
  if (!db) return 0;
  const cutoff = Date.now() - 10 * 60 * 1000;
  const stmt = db.prepare(`
    UPDATE deploys SET status = 'failed', error = COALESCE(error, 'reconciled on restart — actual EAS state unknown, check eas update:list')
    WHERE status = 'executing' AND ts < ?
  `);
  stmt.run([cutoff]);
  stmt.free();
  const r = db.exec('SELECT changes()');
  const n = r[0]?.values?.[0]?.[0] as number | undefined;
  if (typeof n === 'number' && n > 0) scheduleSave();
  return typeof n === 'number' ? n : 0;
}

// ---- Projects ---------------------------------------------------------

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  dir: string;
  createdAt: number;
  lastUsed: number;
}

export function listProjects(): ProjectRow[] {
  if (!db) return [];
  const r = db.exec('SELECT id, slug, name, dir, created_at, last_used FROM projects ORDER BY last_used DESC');
  if (!r.length) return [];
  return r[0].values.map((row: any[]) => ({
    id: row[0], slug: row[1], name: row[2], dir: row[3], createdAt: row[4], lastUsed: row[5],
  }));
}

export function getProject(id: number): ProjectRow | null {
  if (!db) return null;
  const stmt = db.prepare('SELECT id, slug, name, dir, created_at, last_used FROM projects WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.get();
  stmt.free();
  return { id: row[0] as number, slug: row[1] as string, name: row[2] as string, dir: row[3] as string, createdAt: row[4] as number, lastUsed: row[5] as number };
}

export function createProject(name: string, slug: string, dir: string): ProjectRow | null {
  if (!db) return null;
  const ts = Date.now();
  const stmt = db.prepare('INSERT INTO projects (slug, name, dir, created_at, last_used) VALUES (?, ?, ?, ?, ?)');
  stmt.run([slug, name, dir, ts, ts]);
  stmt.free();
  const idR = db.exec('SELECT last_insert_rowid()');
  const id = idR[0]?.values?.[0]?.[0] as number | undefined;
  scheduleSave();
  return id ? { id, slug, name, dir, createdAt: ts, lastUsed: ts } : null;
}

export function deleteProject(id: number): void {
  if (!db) return;
  // Cascade: drop the project's history + memory. The on-disk dir is left
  // alone — caller decides whether to rm it.
  const a = db.prepare('DELETE FROM dispatches WHERE project_id = ?'); a.bind([id]); a.step(); a.free();
  const b = db.prepare('DELETE FROM runs WHERE project_id = ?'); b.bind([id]); b.step(); b.free();
  const c = db.prepare('DELETE FROM chunks WHERE project_id = ?'); c.bind([id]); c.step(); c.free();
  const d = db.prepare('DELETE FROM projects WHERE id = ?'); d.bind([id]); d.step(); d.free();
  scheduleSave();
}

export function touchProject(id: number): void {
  if (!db) return;
  const stmt = db.prepare('UPDATE projects SET last_used = ? WHERE id = ?');
  stmt.run([Date.now(), id]);
  stmt.free();
  scheduleSave();
}

export function getActiveProjectId(): number | null {
  if (!db) return null;
  const r = db.exec("SELECT value FROM meta WHERE key = 'active_project_id'");
  const v = r[0]?.values?.[0]?.[0];
  const n = typeof v === 'string' ? parseInt(v, 10) : (typeof v === 'number' ? v : NaN);
  return Number.isFinite(n) ? n : null;
}

export function setActiveProjectId(id: number): void {
  if (!db) return;
  const stmt = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('active_project_id', ?)");
  stmt.run([String(id)]);
  stmt.free();
  touchProject(id);
}

export function shutdownDb(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persistNow();
}
