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
