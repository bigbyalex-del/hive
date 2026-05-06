// Codebase memory — Remember/Recall tools backed by OpenAI embeddings.
//
// Workers explicitly call Remember(content, [tag]) to save a chunk after
// finishing a piece of work, and Recall(query) at the start of a new task to
// pull the top-K most relevant prior chunks. Embeddings stored as JSON arrays
// in the SQLite chunks table; cosine search is pure JS — fine for the
// thousands of chunks a single user generates.
//
// v0.5.1 — autoEmbedWrite is fire-and-forget hook for Write/Edit tools so the
// chunks index populates passively. Dedupes by content hash so re-saving the
// same file doesn't bloat the table.

import * as crypto from 'crypto';
import { insertChunk, loadChunks } from './db';

const EMBED_MODEL = 'text-embedding-3-small'; // 1536-dim, cheap, high quality
const EMBED_URL = 'https://api.openai.com/v1/embeddings';

export async function embed(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing — embedding requires the same key used for Whisper');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const resp = await fetch(EMBED_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 8000) }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`embed HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json: any = await resp.json();
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error('embedding response missing data[0].embedding');
    return vec;
  } finally {
    clearTimeout(t);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function remember(agentId: string, content: string, tag?: string): Promise<number | null> {
  if (!content.trim()) throw new Error('Remember needs non-empty content');
  const vec = await embed(content);
  return insertChunk({ agentId, tag, content, embedding: vec });
}

// Per-process dedupe cache: sha256 of (relPath + content). Resets on restart,
// at which point a re-write will reseed the chunk anyway — fine for our scale.
const seenWriteHashes = new Set<string>();

// Cap embeddable file size — a 50KB minified bundle won't help Recall and
// will burn embedding cost. Skip text-likeness check; OpenAI handles bytes.
const AUTO_EMBED_MAX_BYTES = 12_000;

// Fire-and-forget. Caller never awaits. Errors swallowed (logged to console)
// so a transient OpenAI hiccup doesn't fail the worker's Write tool call.
export function autoEmbedWrite(relPath: string, content: string): void {
  if (!process.env.OPENAI_API_KEY) return; // no key → silently skip
  if (!content || !content.trim()) return;
  if (Buffer.byteLength(content, 'utf8') > AUTO_EMBED_MAX_BYTES) return;

  const hash = crypto.createHash('sha256').update(relPath).update('|').update(content).digest('hex');
  if (seenWriteHashes.has(hash)) return;
  seenWriteHashes.add(hash);

  // Store under 'shared' so any worker can Recall it later. Tag with the path
  // so the model sees the source file in the result.
  const note = `## File: ${relPath}\n\n${content.slice(0, 8000)}`;
  void (async () => {
    try {
      await remember('shared', note, `file:${relPath}`);
    } catch (err) {
      console.warn('[hive] autoEmbedWrite failed:', (err as Error).message);
    }
  })();
}

export async function recall(agentId: string, query: string, limit = 5): Promise<{ tag: string | null; content: string; score: number }[]> {
  if (!query.trim()) throw new Error('Recall needs a non-empty query');
  // Pull all chunks for this agent + the special 'shared' agent (cross-worker
  // memory pool). Cosine over them all.
  const rows = [...loadChunks(agentId), ...loadChunks('shared')];
  if (rows.length === 0) return [];
  const qvec = await embed(query);
  const scored = rows.map(r => ({ tag: r.tag, content: r.content, score: cosine(qvec, r.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(20, limit)));
}
