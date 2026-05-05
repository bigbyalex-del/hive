// Codebase memory — Remember/Recall tools backed by OpenAI embeddings.
//
// Workers explicitly call Remember(content, [tag]) to save a chunk after
// finishing a piece of work, and Recall(query) at the start of a new task to
// pull the top-K most relevant prior chunks. Embeddings stored as JSON arrays
// in the SQLite chunks table; cosine search is pure JS — fine for the
// thousands of chunks a single user generates.

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
