// Full-codebase snapshot for advisor full-context mode.
//
// Walks the FXV `mobile/src/` tree, concatenates every TS/TSX/JSON file as
// one big tagged string. Cached in memory; rebuilt when the file watcher
// fires. Designed to be sent as an Anthropic `cache_control: ephemeral`
// prefix so every advisor turn within ~5min hits the cache (10x cheaper).

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

const FXV_REPO = 'C:\\Users\\Fusion\\.openclaw\\workspace\\fxv-performance';
const ROOTS = [
  { path: FXV_REPO + '\\mobile\\src', label: 'mobile' },
  { path: FXV_REPO + '\\supabase\\functions', label: 'backend' },
];
const EXTRAS = [
  FXV_REPO + '\\mobile\\app.json',
  FXV_REPO + '\\mobile\\package.json',
];
const INCLUDE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'web-stubs', '__tests__', 'ios', 'android', 'dist', 'build', '.expo']);
const MAX_FILE_BYTES = 80_000;   // skip absurdly large generated files
const MAX_TOTAL_BYTES = 750_000; // ~190k tokens, safe under Claude's 200k ceiling

interface SnapshotMeta {
  text: string;
  builtAt: number;
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
}

let cached: SnapshotMeta | null = null;
let building: Promise<SnapshotMeta> | null = null;
const watchers: fs.FSWatcher[] = [];
let invalidateTimer: NodeJS.Timeout | null = null;

async function walk(root: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[] = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && INCLUDE_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

async function buildSnapshot(): Promise<SnapshotMeta> {
  const files: string[] = [];
  for (const root of ROOTS) await walk(root.path, files);
  for (const extra of EXTRAS) {
    try { await fsp.access(extra); files.unshift(extra); } catch {}
  }
  files.sort();

  const parts: string[] = [];
  parts.push('=== FXV CODEBASE SNAPSHOT ===');
  parts.push(`Generated: ${new Date().toISOString()}`);
  parts.push('Roots:');
  for (const r of ROOTS) parts.push(`  ${r.label}: ${r.path}`);
  parts.push('');
  parts.push('This is the COMPLETE current FXV codebase (mobile app + Supabase edge');
  parts.push('functions). Every file the agents might need to answer questions about');
  parts.push('FXV is included below. When citing, reference files by their relative');
  parts.push('path (e.g. "mobile/src/screens/dashboard/DashboardScreen.tsx:142" or');
  parts.push('"supabase/functions/generate-programme/assembler.ts:42"). Do NOT claim a');
  parts.push('file exists if it is not below.');
  parts.push('');

  let totalBytes = parts.join('\n').length;
  let count = 0;
  let truncated = false;
  for (const f of files) {
    let content: string;
    try { content = await fsp.readFile(f, 'utf8'); } catch { continue; }
    if (content.length > MAX_FILE_BYTES) content = content.slice(0, MAX_FILE_BYTES) + `\n\n…(truncated — file is ${content.length} bytes total)`;
    const rel = path.relative(FXV_REPO, f).replace(/\\/g, '/');
    const block = `\n=== ${rel} ===\n${content}\n`;
    if (totalBytes + block.length > MAX_TOTAL_BYTES) { truncated = true; break; }
    parts.push(block);
    totalBytes += block.length;
    count++;
  }
  if (truncated) parts.push(`\n=== TRUNCATED (${files.length - count} files omitted, total size cap ${MAX_TOTAL_BYTES} bytes) ===`);

  return {
    text: parts.join(''),
    builtAt: Date.now(),
    fileCount: count,
    totalBytes,
    truncated,
  };
}

export async function getSnapshot(): Promise<SnapshotMeta> {
  if (cached) return cached;
  if (building) return building;
  building = (async () => {
    try {
      cached = await buildSnapshot();
      ensureWatcher();
      return cached;
    } finally {
      building = null;
    }
  })();
  return building;
}

export function invalidateSnapshot(): void {
  cached = null;
}

export function getSnapshotStats(): { fileCount: number; bytes: number; builtAt: number; truncated: boolean } | null {
  if (!cached) return null;
  return { fileCount: cached.fileCount, bytes: cached.totalBytes, builtAt: cached.builtAt, truncated: cached.truncated };
}

function ensureWatcher() {
  if (watchers.length) return;
  for (const root of ROOTS) {
    try {
      const w = fs.watch(root.path, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const ext = path.extname(String(filename)).toLowerCase();
        if (!INCLUDE_EXT.has(ext)) return;
        if (String(filename).includes('web-stubs')) return;
        if (invalidateTimer) clearTimeout(invalidateTimer);
        invalidateTimer = setTimeout(() => { invalidateSnapshot(); invalidateTimer = null; }, 800);
      });
      w.on('error', () => { try { w.close(); } catch {} });
      watchers.push(w);
    } catch {
      // best-effort
    }
  }
}
