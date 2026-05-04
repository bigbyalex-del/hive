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
  `);

  console.log(`[hive] db ready at ${file}`);
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

export function recordDispatch(userInput: string, subtasks: { task: string; model?: string }[]): number | null {
  if (!db) return null;
  const ts = Date.now();
  const stmt = db.prepare('INSERT INTO dispatches (ts, user_input, subtasks_json) VALUES (?, ?, ?)');
  stmt.run([ts, userInput, JSON.stringify(subtasks)]);
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
}): void {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO runs (dispatch_id, ts, agent_id, model, input_tokens, output_tokens, status, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
  ]);
  stmt.free();
  scheduleSave();
}

export function loadRecentDispatches(limit = 20): { userInput: string; subtasks: { task: string; model?: string }[]; timestamp: number }[] {
  if (!db) return [];
  const result = db.exec(`SELECT ts, user_input, subtasks_json FROM dispatches ORDER BY ts DESC LIMIT ${limit}`);
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

export function shutdownDb(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persistNow();
}
