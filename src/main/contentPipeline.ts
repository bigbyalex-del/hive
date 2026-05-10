// Content pipeline — the orchestrator that turns queue.json[0] into a
// ready-to-publish draft folder.
//
// Steps:
//   1. Read queue.json. If empty, refill from seed-topics.json (Phase 3
//      will add advisor-chats + brainstorm-actions sources).
//   2. Pick queue[0]. Write a lockfile so a second concurrent invocation
//      sees "in progress" and bails.
//   3. draftPost — research via the topic's specialists, Sonnet writes.
//   4. renderPostHtml — substitute into blog.html template.
//   5. draftHeroSpec — Sonnet fills topic-specific values for the chosen
//      hero composition template.
//   6. renderHeroComposition — substitute into hero-{template}.html.
//   7. renderHeroMp4 — spawn hyperframes render → mp4 file.
//   8. draftSocialBundles — IG / TikTok / Twitter in parallel (Haiku).
//   9. writeDraftFolder — drop everything into drafts/<date>-<slug>/.
//   10. Pop topic from queue, save queue.json. Remove lockfile.
//   11. Invalidate the drafts cache so the row picks up the new folder
//       on its next 30s tick.
//
// Total ~3-5 minutes per draft. Cost ~£0.10.
//
// Failures in any stage write a `_failed.json` into the draft folder and
// bail out; the topic stays in the queue so the next run can retry.

import * as fs from 'fs';
import * as path from 'path';
import { draftPost, draftHeroSpec, draftSocialBundles, type QueueTopic, type DraftedPost, type HeroSpec } from './contentWriter';
import { renderPostHtml, renderHeroComposition, renderHeroMp4, writeDraftFolder } from './contentRenderer';
import { invalidateDraftsCache } from './drafts';

const FXV_CONTENT_ROOT = 'C:/Users/Fusion/fxv-content';
const QUEUE_PATH = path.join(FXV_CONTENT_ROOT, 'queue.json');
const SEED_TOPICS_PATH = path.join(FXV_CONTENT_ROOT, 'seed-topics.json');
const LOCKFILE_PATH = path.join(FXV_CONTENT_ROOT, '.in-progress.json');

export type PipelineProgress =
  | { type: 'start'; topic: QueueTopic }
  | { type: 'stage'; stage: string; line: string }
  | { type: 'done'; draftPath: string; durationMs: number }
  | { type: 'error'; stage: string; error: string };

export interface PipelineResult {
  ok: boolean;
  draftPath: string | null;
  durationMs: number;
  error?: string;
  topic?: QueueTopic;
}

function readJson(p: string): any | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeJson(p: string, value: any): void {
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isLocked(): { locked: boolean; sinceMs?: number } {
  if (!fs.existsSync(LOCKFILE_PATH)) return { locked: false };
  const lock = readJson(LOCKFILE_PATH);
  if (!lock?.startedAt) return { locked: false };
  const sinceMs = Date.now() - Number(lock.startedAt);
  // Stale lock (>15 min — way longer than a normal pipeline run) → ignore
  if (sinceMs > 15 * 60_000) return { locked: false, sinceMs };
  return { locked: true, sinceMs };
}

function takeLock(topic: QueueTopic): void {
  writeJson(LOCKFILE_PATH, { topic, startedAt: Date.now() });
}
function releaseLock(): void {
  try { fs.unlinkSync(LOCKFILE_PATH); } catch { /* fine */ }
}

function refillQueueFromSeeds(currentQueue: any[]): any[] {
  const seedFile = readJson(SEED_TOPICS_PATH);
  const seedTopics = Array.isArray(seedFile?.topics) ? seedFile.topics : [];
  const haveSlugs = new Set(currentQueue.map((q: any) => q.slug));
  // Pull seed topics that aren't already queued, prefer high priority.
  const candidates = seedTopics
    .filter((t: any) => !haveSlugs.has(t.slug))
    .filter((t: any) => !t.note || !t.note.toLowerCase().includes('already published'))
    .sort((a: any, b: any) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.priority as keyof typeof order] ?? 9) - (order[b.priority as keyof typeof order] ?? 9);
    });
  const today = todayIso();
  return candidates.slice(0, 5 - currentQueue.length).map((t: any) => ({
    ...t,
    addedAt: today,
    source: 'seed',
  }));
}

export interface RunOpts {
  onProgress?: (evt: PipelineProgress) => void;
  // Optional: override which topic is picked. Useful for testing without
  // mutating queue.json.
  topicOverride?: QueueTopic;
  dryRun?: boolean;            // don't write to disk, don't pop queue
}

export async function generateNextDraft(opts: RunOpts = {}): Promise<PipelineResult> {
  const startedAt = Date.now();
  const emit = (evt: PipelineProgress) => opts.onProgress?.(evt);

  // ---- Lock check ----
  const lock = isLocked();
  if (lock.locked) {
    const err = `pipeline is already running (started ${Math.round((lock.sinceMs ?? 0) / 1000)}s ago)`;
    emit({ type: 'error', stage: 'lock', error: err });
    return { ok: false, draftPath: null, durationMs: 0, error: err };
  }

  // ---- Pick topic ----
  let topic: QueueTopic;
  let queueAfterPick: any[];
  if (opts.topicOverride) {
    topic = opts.topicOverride;
    queueAfterPick = readJson(QUEUE_PATH)?.queue ?? [];
  } else {
    const qFile = readJson(QUEUE_PATH) ?? { queue: [] };
    let queue: any[] = Array.isArray(qFile.queue) ? qFile.queue : [];
    if (queue.length === 0) {
      const refilled = refillQueueFromSeeds([]);
      if (refilled.length === 0) {
        const err = 'queue is empty and no eligible seed topics to refill';
        emit({ type: 'error', stage: 'pick', error: err });
        return { ok: false, draftPath: null, durationMs: 0, error: err };
      }
      queue = refilled;
      qFile.queue = queue;
      qFile.lastRefilledAt = todayIso();
      writeJson(QUEUE_PATH, qFile);
    }
    topic = queue[0];
    queueAfterPick = queue.slice(1);
  }
  emit({ type: 'start', topic });

  if (!opts.dryRun) takeLock(topic);

  try {
    // ---- Stage 1: draft post ----
    let post: DraftedPost;
    try {
      post = await draftPost({
        topic,
        onProgress: (line) => emit({ type: 'stage', stage: 'draft-post', line }),
      });
    } catch (err: any) {
      throw { stage: 'draft-post', error: err?.message ?? String(err) };
    }

    // ---- Stage 2: render post.html ----
    emit({ type: 'stage', stage: 'render-post-html', line: '[render] substituting into blog.html template...' });
    const isoDate = todayIso();
    const postHtml = renderPostHtml(post, isoDate);

    // ---- Stage 3: hero spec ----
    let heroSpec: HeroSpec;
    try {
      heroSpec = await draftHeroSpec(topic, post, (line) => emit({ type: 'stage', stage: 'hero-spec', line }));
    } catch (err: any) {
      throw { stage: 'hero-spec', error: err?.message ?? String(err) };
    }

    // ---- Stage 4: render hero composition ----
    emit({ type: 'stage', stage: 'render-hero-html', line: `[render] substituting into ${heroSpec.template}.html template...` });
    const heroHtml = renderHeroComposition(heroSpec);

    // ---- Stage 5: render hero.mp4 ----
    const folderName = `${isoDate}-${topic.slug}`;
    const heroMp4Path = path.join(FXV_CONTENT_ROOT, 'drafts', folderName, 'hero.mp4');
    let heroMp4Result: { ok: boolean; outputPath: string | null; error?: string };
    if (opts.dryRun) {
      emit({ type: 'stage', stage: 'render-hero-mp4', line: '[render] DRY RUN — skipping hyperframes render' });
      heroMp4Result = { ok: false, outputPath: null, error: 'dry run' };
    } else {
      try {
        heroMp4Result = await renderHeroMp4({
          heroHtmlContents: heroHtml,
          outputMp4Path: heroMp4Path,
          onLine: (line) => emit({ type: 'stage', stage: 'render-hero-mp4', line }),
        });
      } catch (err: any) {
        throw { stage: 'render-hero-mp4', error: err?.message ?? String(err) };
      }
    }

    // ---- Stage 6: social bundles (parallel) ----
    let social: import('./contentWriter').SocialBundle;
    try {
      social = await draftSocialBundles(topic, post, (line) => emit({ type: 'stage', stage: 'social', line }));
    } catch (err: any) {
      throw { stage: 'social', error: err?.message ?? String(err) };
    }

    // ---- Stage 7: write draft folder ----
    let draftPath: string;
    if (opts.dryRun) {
      emit({ type: 'stage', stage: 'write', line: '[write] DRY RUN — would have written draft folder' });
      draftPath = path.join(FXV_CONTENT_ROOT, 'drafts', folderName);
    } else {
      draftPath = writeDraftFolder({
        topic,
        post,
        postHtml,
        heroSpec,
        heroHtml,
        heroMp4Path: heroMp4Result.ok ? heroMp4Path : null,
        social,
        isoDate,
      });
    }

    // ---- Pop topic from queue ----
    if (!opts.dryRun && !opts.topicOverride) {
      const qFile = readJson(QUEUE_PATH) ?? { queue: [] };
      qFile.queue = queueAfterPick;
      writeJson(QUEUE_PATH, qFile);
    }

    invalidateDraftsCache();
    releaseLock();

    const durationMs = Date.now() - startedAt;
    emit({ type: 'done', draftPath, durationMs });
    return { ok: true, draftPath, durationMs, topic };

  } catch (err: any) {
    releaseLock();
    const stage = err?.stage ?? 'unknown';
    const errMsg = err?.error ?? err?.message ?? String(err);
    emit({ type: 'error', stage, error: errMsg });
    const durationMs = Date.now() - startedAt;
    return { ok: false, draftPath: null, durationMs, error: `[${stage}] ${errMsg}`, topic };
  }
}

export interface QueueSummary {
  count: number;
  topics: { title: string; slug: string; priority: string; source: string }[];
  lastRefilledAt: string | null;
  isLocked: boolean;
  lockedTopic: QueueTopic | null;
}

export function getQueueSummary(): QueueSummary {
  const q = readJson(QUEUE_PATH) ?? { queue: [], lastRefilledAt: null };
  const lock = readJson(LOCKFILE_PATH);
  return {
    count: Array.isArray(q.queue) ? q.queue.length : 0,
    topics: (Array.isArray(q.queue) ? q.queue : []).slice(0, 10).map((t: any) => ({
      title: String(t.title ?? ''),
      slug: String(t.slug ?? ''),
      priority: String(t.priority ?? 'medium'),
      source: String(t.source ?? 'seed'),
    })),
    lastRefilledAt: q.lastRefilledAt ?? null,
    isLocked: !!lock,
    lockedTopic: lock?.topic ?? null,
  };
}
