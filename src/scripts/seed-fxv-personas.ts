// Seed FXV advisor personas with grounded knowledge from the FXV repo.
//
// Reads personas.json (project root), walks each persona's seed_globs against
// the FXV repo (READ-ONLY — never writes back), chunks each file, embeds via
// OpenAI text-embedding-3-small, and stores in Hive's SQLite chunks table at
// project_id=NULL (cross-project; advisors aren't tied to a Hive project).
//
// Idempotent: clears each persona's chunks before reseeding. Re-run after
// FXV repo changes to refresh.
//
// Run with:  node dist/scripts/seed-fxv-personas.js
// Requires:  OPENAI_API_KEY in env (same key Hive already uses for embeddings)

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

import { initDb, persistNow, deleteChunksForAgent, insertChunk, countChunksForAgent } from '../main/db';
import { embed } from '../main/memory';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

interface Persona {
  id: string;
  name: string;
  title: string;
  scope?: string;
  seed_globs: string[];
  memory_globs?: string[];
  isManager?: boolean;
}
interface PersonasFile {
  fxvRepoPath: string;
  claudeMemoryPath?: string;
  sharedAgentId: string;
  sharedSeedGlobs: string[];
  sharedMemoryGlobs?: string[];
  personas: Persona[];
}

const CHUNK_BYTES = 6_000;     // ~1500 tokens — comfortable for the 8KB embed cap
const CHUNK_OVERLAP_BYTES = 400;

function chunk(text: string, sourceLabel: string): string[] {
  if (text.length <= CHUNK_BYTES) return [`## Source: ${sourceLabel}\n\n${text}`];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const slice = text.slice(i, i + CHUNK_BYTES);
    out.push(`## Source: ${sourceLabel}\n\n${slice}`);
    if (i + CHUNK_BYTES >= text.length) break;
    i += CHUNK_BYTES - CHUNK_OVERLAP_BYTES;
  }
  return out;
}

function readFileSafe(abs: string): string | null {
  try {
    if (!fs.existsSync(abs)) return null;
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    console.warn(`[seed]   skip ${abs} — ${(err as Error).message}`);
    return null;
  }
}

async function ingestPaths(
  agentId: string,
  baseDir: string,
  globs: string[],
  labelPrefix: string,
): Promise<{ chunks: number; files: number; missing: string[] }> {
  let chunks = 0;
  let files = 0;
  const missing: string[] = [];
  for (const rel of globs) {
    const abs = path.resolve(baseDir, rel);
    const content = readFileSafe(abs);
    if (content == null) {
      missing.push(rel);
      console.warn(`[seed]   missing: ${rel}`);
      continue;
    }
    files++;
    const sha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
    const display = labelPrefix ? `${labelPrefix}:${rel}` : rel;
    const tag = `src:${display}#${sha}`;
    const pieces = chunk(content, display);
    for (const piece of pieces) {
      const vec = await embed(piece);
      insertChunk({ agentId, tag, content: piece, embedding: vec, projectId: null });
      chunks++;
    }
    console.log(`[seed]   ${display}  →  ${pieces.length} chunk(s)`);
  }
  return { chunks, files, missing };
}

async function ingestForAgent(
  agentId: string,
  fxvRoot: string,
  memoryRoot: string | null,
  seedGlobs: string[],
  memoryGlobs: string[],
): Promise<{ chunks: number; files: number; missing: string[] }> {
  const repoResult = await ingestPaths(agentId, fxvRoot, seedGlobs, 'repo');
  let memResult: { chunks: number; files: number; missing: string[] } = { chunks: 0, files: 0, missing: [] };
  if (memoryRoot && memoryGlobs.length > 0) {
    memResult = await ingestPaths(agentId, memoryRoot, memoryGlobs, 'memory');
  }
  return {
    chunks: repoResult.chunks + memResult.chunks,
    files: repoResult.files + memResult.files,
    missing: [...repoResult.missing, ...memResult.missing],
  };
}

// ---- Auto-routing classifier --------------------------------------------
// Before each seed run, discover new files (in FXV repo + CLAUDE memory dir)
// that aren't yet listed in any persona's globs. For each, ask Haiku which
// persona(s) should own it. Writes the decision back to personas.json so the
// mapping survives across runs.

const FXV_DISCOVER_DIRS: { rel: string; ext: string[] }[] = [
  { rel: 'mobile/src/screens',   ext: ['.tsx', '.ts'] },
  { rel: 'mobile/src/components', ext: ['.tsx', '.ts'] },
  { rel: 'mobile/src/hooks',      ext: ['.ts'] },
  { rel: 'mobile/src/store',      ext: ['.ts'] },
  { rel: 'mobile/src/services',   ext: ['.ts'] },
  { rel: 'mobile/src/engine',     ext: ['.ts'] },
  { rel: 'mobile/src/api',        ext: ['.ts'] },
  { rel: 'supabase/functions',    ext: ['.ts'] },
  { rel: 'docs',                  ext: ['.md'] },
  { rel: 'site',                  ext: ['.html', '.md'] },
];
// Top-level FXV repo files to consider — root-level docs only.
const FXV_TOP_LEVEL_EXT = ['.md'];

// CLAUDE memory whitelist — only FXV-domain files. Skips PII / Hive / Maths /
// session-resume noise.
const MEMORY_INCLUDE = /^(project_fxv_|feedback_|reference_)/;
const MEMORY_EXCLUDE_NAMES = new Set([
  'feedback_keep_answers_short.md',
  'feedback_pixellab_icons.md',
  'reference_github_repos.md',
  'reference_safety_protections.md',
]);
const MEMORY_EXCLUDE_PREFIX = /^(project_hive|project_maths|user_|session_resume_|MEMORY)/;

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.expo', 'android', 'ios', 'dist', 'build',
  'coverage', '.next', '.cache', '__tests__', '.vscode',
]);

const MAX_CLASSIFY_PER_RUN = 30;

function listFilesRecursive(root: string, exts: string[]): string[] {
  const out: string[] = [];
  function walk(dir: string, rel: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (exts.some(ext => e.name.endsWith(ext))) out.push(r);
    }
  }
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

function listMemoryFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(name => name.endsWith('.md'))
    .filter(name => !MEMORY_EXCLUDE_NAMES.has(name))
    .filter(name => !MEMORY_EXCLUDE_PREFIX.test(name))
    .filter(name => MEMORY_INCLUDE.test(name));
}

function gatherKnownGlobs(personas: PersonasFile): { repo: Set<string>; memory: Set<string> } {
  const repo = new Set<string>();
  const memory = new Set<string>();
  for (const g of personas.sharedSeedGlobs ?? []) repo.add(g);
  for (const g of personas.sharedMemoryGlobs ?? []) memory.add(g);
  for (const p of personas.personas) {
    for (const g of p.seed_globs ?? []) repo.add(g);
    for (const g of p.memory_globs ?? []) memory.add(g);
  }
  return { repo, memory };
}

const dynamicImportSdk = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
let _haikuClient: any = null;
async function haikuClient() {
  if (_haikuClient) return _haikuClient;
  const mod = await dynamicImportSdk('@anthropic-ai/sdk');
  const Ctor = mod.default ?? mod.Anthropic;
  _haikuClient = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _haikuClient;
}

async function classifyFile(
  filePath: string,
  contentSnippet: string,
  personas: Persona[],
  origin: 'repo' | 'memory',
): Promise<string[]> {
  // Manager has no own seed_globs (synthesises across), so don't classify into it.
  const candidates = personas.filter(p => !p.isManager);
  const personaList = candidates.map(p => `- ${p.id} (${p.name}): ${p.scope ?? p.title}`).join('\n');
  const systemPrompt = `You classify FXV files into specialist namespaces. Output ONLY a JSON array of persona ids — pick the 1-2 personas that best own this file. If none fit, return []. Examples: ["fxv:strength"] or ["fxv:strength","fxv:concurrent"] or [].`;
  const originLabel = origin === 'repo' ? 'FXV codebase' : 'curated CLAUDE memory note';
  const userPrompt = `PERSONAS:\n${personaList}\n\nFILE: ${filePath}\nORIGIN: ${originLabel}\n\nFILE EXCERPT:\n${contentSnippet.slice(0, 2400)}`;

  let resp: any;
  try {
    const client = await haikuClient();
    resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.warn(`[classify] Haiku call failed for ${filePath}: ${(err as Error).message}`);
    return [];
  }

  const textBlocks = resp.content.filter((b: any) => b.type === 'text');
  const text = textBlocks.map((b: any) => b.text).join('').trim();
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    const validIds = new Set(candidates.map(p => p.id));
    return parsed.filter(id => typeof id === 'string' && validIds.has(id)).slice(0, 2);
  } catch {
    return [];
  }
}

async function discoverAndRoute(
  personas: PersonasFile,
  fxvRoot: string,
  memoryRoot: string | null,
  log: (line: string) => void,
): Promise<{ added: number; skipped: number }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log('[classify] ANTHROPIC_API_KEY missing — skipping auto-routing');
    return { added: 0, skipped: 0 };
  }

  const known = gatherKnownGlobs(personas);

  // FXV repo discovery — known dirs + top-level *.md
  const repoFound: string[] = [];
  for (const d of FXV_DISCOVER_DIRS) {
    const abs = path.join(fxvRoot, d.rel);
    const files = listFilesRecursive(abs, d.ext);
    for (const f of files) repoFound.push(`${d.rel}/${f}`);
  }
  // Top-level .md
  try {
    const top = fs.readdirSync(fxvRoot, { withFileTypes: true });
    for (const e of top) {
      if (e.isFile() && FXV_TOP_LEVEL_EXT.some(ext => e.name.endsWith(ext))) repoFound.push(e.name);
    }
  } catch { /* fine */ }

  // CLAUDE memory discovery
  const memoryFound = memoryRoot ? listMemoryFiles(memoryRoot) : [];

  const newRepo = repoFound.filter(p => !known.repo.has(p));
  const newMemory = memoryFound.filter(p => !known.memory.has(p));

  const total = newRepo.length + newMemory.length;
  if (total === 0) {
    log('[classify] no new files to route — all known');
    return { added: 0, skipped: 0 };
  }
  log(`[classify] ${newRepo.length} new repo files, ${newMemory.length} new memory files`);

  // Cap to avoid surprise spend.
  const repoToProcess = newRepo.slice(0, MAX_CLASSIFY_PER_RUN);
  const remaining = MAX_CLASSIFY_PER_RUN - repoToProcess.length;
  const memoryToProcess = newMemory.slice(0, Math.max(0, remaining));
  const skipped = (newRepo.length - repoToProcess.length) + (newMemory.length - memoryToProcess.length);
  if (skipped > 0) log(`[classify] capping at ${MAX_CLASSIFY_PER_RUN} — ${skipped} deferred to next refresh`);

  let added = 0;
  for (const rel of repoToProcess) {
    const abs = path.join(fxvRoot, rel);
    let snippet = '';
    try { snippet = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const ids = await classifyFile(rel, snippet, personas.personas, 'repo');
    if (ids.length === 0) {
      log(`[classify]   ${rel}  →  (none)`);
      continue;
    }
    for (const id of ids) {
      const p = personas.personas.find(x => x.id === id);
      if (!p) continue;
      if (!p.seed_globs.includes(rel)) {
        p.seed_globs.push(rel);
        added++;
      }
    }
    log(`[classify]   ${rel}  →  ${ids.join(', ')}`);
  }
  for (const rel of memoryToProcess) {
    const abs = path.join(memoryRoot!, rel);
    let snippet = '';
    try { snippet = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const ids = await classifyFile(rel, snippet, personas.personas, 'memory');
    if (ids.length === 0) {
      log(`[classify]   memory:${rel}  →  (none)`);
      continue;
    }
    for (const id of ids) {
      const p = personas.personas.find(x => x.id === id);
      if (!p) continue;
      if (!p.memory_globs) p.memory_globs = [];
      if (!p.memory_globs.includes(rel)) {
        p.memory_globs.push(rel);
        added++;
      }
    }
    log(`[classify]   memory:${rel}  →  ${ids.join(', ')}`);
  }

  return { added, skipped };
}

function persistPersonas(personasPath: string, personas: PersonasFile): void {
  fs.writeFileSync(personasPath, JSON.stringify(personas, null, 2) + '\n', 'utf8');
}

// Callable from inside the Electron main process (refresh button) as well as
// the standalone CLI. Caller passes a log fn so renderer can stream progress.
export interface SeedSummary {
  ok: boolean;
  error?: string;
  totalChunks: number;
  totalFiles: number;
  perAgent: { id: string; name: string; chunks: number; files: number; missing: number }[];
}

export async function runSeed(log: (line: string) => void = console.log): Promise<SeedSummary> {
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, error: 'OPENAI_API_KEY missing in .env', totalChunks: 0, totalFiles: 0, perAgent: [] };
  }

  const personasPath = path.join(__dirname, '..', '..', 'personas.json');
  if (!fs.existsSync(personasPath)) {
    return { ok: false, error: `personas.json not found at ${personasPath}`, totalChunks: 0, totalFiles: 0, perAgent: [] };
  }
  const personas: PersonasFile = JSON.parse(fs.readFileSync(personasPath, 'utf8'));
  const fxvRoot = personas.fxvRepoPath;
  if (!fs.existsSync(fxvRoot)) {
    return { ok: false, error: `FXV repo not found at ${fxvRoot}`, totalChunks: 0, totalFiles: 0, perAgent: [] };
  }

  log(`[seed] FXV repo: ${fxvRoot}`);
  const memoryRoot = personas.claudeMemoryPath && fs.existsSync(personas.claudeMemoryPath) ? personas.claudeMemoryPath : null;
  if (memoryRoot) log(`[seed] CLAUDE memory: ${memoryRoot}`);

  // Auto-routing: discover any files not yet listed in any persona's globs,
  // ask Haiku which agent should own them, mutate personas in place, persist.
  log('[classify] scanning for new files...');
  const routed = await discoverAndRoute(personas, fxvRoot, memoryRoot, log);
  if (routed.added > 0) {
    persistPersonas(personasPath, personas);
    log(`[classify] routed ${routed.added} new file→agent mapping(s); personas.json updated`);
  } else if (routed.skipped > 0) {
    log(`[classify] ${routed.skipped} file(s) deferred (cap=${MAX_CLASSIFY_PER_RUN}); none added this run`);
  }

  await initDb();

  // Shared FXV pool first — every advisor reads from this.
  log(`[seed] === ${personas.sharedAgentId} (shared pool) ===`);
  deleteChunksForAgent(personas.sharedAgentId);
  const shared = await ingestForAgent(
    personas.sharedAgentId,
    fxvRoot,
    memoryRoot,
    personas.sharedSeedGlobs,
    personas.sharedMemoryGlobs ?? [],
  );
  log(`[seed] shared: ${shared.files} file(s), ${shared.chunks} chunk(s), ${shared.missing.length} missing`);

  // Per-persona namespaces. Manager has no own seed_globs — it pulls from
  // every specialist's namespace at query time.
  const perAgent: SeedSummary['perAgent'] = [
    { id: personas.sharedAgentId, name: 'Shared', chunks: shared.chunks, files: shared.files, missing: shared.missing.length },
  ];
  let totalChunks = shared.chunks;
  let totalFiles = shared.files;
  for (const p of personas.personas) {
    const seeds = p.seed_globs ?? [];
    const memoryGlobs = p.memory_globs ?? [];
    if (seeds.length === 0 && memoryGlobs.length === 0) {
      log(`[seed] === ${p.id} (${p.name}) — no globs, skipping`);
      perAgent.push({ id: p.id, name: p.name, chunks: 0, files: 0, missing: 0 });
      continue;
    }
    log(`[seed] === ${p.id} (${p.name}) ===`);
    deleteChunksForAgent(p.id);
    const result = await ingestForAgent(p.id, fxvRoot, memoryRoot, seeds, memoryGlobs);
    perAgent.push({ id: p.id, name: p.name, chunks: result.chunks, files: result.files, missing: result.missing.length });
    totalChunks += result.chunks;
    totalFiles += result.files;
  }

  persistNow();

  log(`[seed] DONE — ${totalFiles} files, ${totalChunks} chunks`);
  return { ok: true, totalChunks, totalFiles, perAgent };
}

// Allow `node dist/scripts/seed-fxv-personas.js` to run standalone.
if (require.main === module) {
  runSeed(line => console.log(line)).then(s => {
    if (!s.ok) {
      console.error('[seed] failed:', s.error);
      process.exit(1);
    }
    console.log(`[seed] ${'persona'.padEnd(22)}  files  chunks  missing  in-db`);
    for (const a of s.perAgent) {
      const inDb = countChunksForAgent(a.id);
      console.log(`[seed] ${a.id.padEnd(22)}  ${String(a.files).padStart(5)}  ${String(a.chunks).padStart(6)}  ${String(a.missing).padStart(7)}  ${String(inDb).padStart(5)}`);
    }
  }).catch(err => {
    console.error('[seed] fatal:', err);
    process.exit(1);
  });
}
