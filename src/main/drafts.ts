// Drafts scanner — surfaces fxv-content/drafts/* into Hive's UI.
//
// One DraftSummary per draft folder. Reads each folder's meta.json (the
// canonical metadata file) plus checks which optional artifacts exist
// (hero.mp4, ig-carousel.json, tiktok-script.md, twitter-thread.md).
//
// Cached for 10s so the UI's 30s refresh loop doesn't hammer the disk.

import * as fs from 'fs';
import * as path from 'path';
import { shell } from 'electron';

const DRAFTS_ROOT = 'C:/Users/Fusion/fxv-content/drafts';
const PUBLISHED_ROOT = 'C:/Users/Fusion/fxv-content/published';
const SCAN_TTL_MS = 10_000;

export interface DraftArtifacts {
  hasPostMd: boolean;
  hasPostHtml: boolean;
  hasHeroHtml: boolean;
  hasHeroMp4: boolean;
  hasIgCarousel: boolean;
  hasTiktokScript: boolean;
  hasTwitterThread: boolean;
}

export interface DraftSummary {
  slug: string;
  folderPath: string;          // absolute path to the draft folder
  title: string;
  date: string;                // ISO YYYY-MM-DD from meta.json or folder name
  category: string | null;
  readTime: number | null;
  intro: string | null;
  personas: string[];
  heroTemplate: string | null;
  heroPath: string | null;     // absolute path to hero.mp4 if it exists
  citationCount: number;
  artifacts: DraftArtifacts;
  freshness: 'new' | 'recent' | 'stale';  // <2h, <2d, else
  mtime: number;               // most recent file mtime in the folder
  approvedByPersona: string | null;
  publishedAt: number | null;  // null = unpublished (lives in drafts/)
}

let cache: { items: DraftSummary[]; expires: number } | null = null;

function safeReadJson(p: string): any | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function freshnessFor(mtime: number): DraftSummary['freshness'] {
  const ageMs = Date.now() - mtime;
  if (ageMs < 2 * 60 * 60 * 1000) return 'new';
  if (ageMs < 2 * 24 * 60 * 60 * 1000) return 'recent';
  return 'stale';
}

function scanFolder(slugRoot: string, slug: string, isPublished: boolean): DraftSummary | null {
  const folder = path.join(slugRoot, slug);
  let stat;
  try { stat = fs.statSync(folder); } catch { return null; }
  if (!stat.isDirectory()) return null;

  const metaPath = path.join(folder, 'meta.json');
  const meta = safeReadJson(metaPath) ?? {};

  const hasPostMd = fs.existsSync(path.join(folder, 'post.md'));
  const hasPostHtml = fs.existsSync(path.join(folder, 'post.html'));
  const hasHeroHtml = fs.existsSync(path.join(folder, 'hero.html'));
  const hasHeroMp4 = fs.existsSync(path.join(folder, 'hero.mp4'));
  const hasIgCarousel = fs.existsSync(path.join(folder, 'ig-carousel.json'));
  const hasTiktokScript = fs.existsSync(path.join(folder, 'tiktok-script.md'));
  const hasTwitterThread = fs.existsSync(path.join(folder, 'twitter-thread.md'));

  // Most-recent mtime across folder contents — drives freshness pip.
  let mtime = stat.mtimeMs;
  try {
    for (const f of fs.readdirSync(folder)) {
      const m = fs.statSync(path.join(folder, f)).mtimeMs;
      if (m > mtime) mtime = m;
    }
  } catch { /* fine */ }

  // Date: prefer meta.json's date; else parse YYYY-MM-DD prefix from slug.
  let date = String(meta.date ?? '');
  if (!date) {
    const m = slug.match(/^(\d{4}-\d{2}-\d{2})/);
    date = m ? m[1] : '';
  }

  // Slug field on meta usually matches the folder name minus the date prefix.
  // Normalise: prefer the meta slug if present, else fall back to folder name.
  const slugForDisplay = String(meta.slug ?? slug.replace(/^\d{4}-\d{2}-\d{2}-/, ''));

  return {
    slug: slugForDisplay,
    folderPath: folder,
    title: String(meta.title ?? slug),
    date,
    category: meta.category ?? null,
    readTime: typeof meta.read_time === 'number' ? meta.read_time : null,
    intro: meta.intro ?? null,
    personas: Array.isArray(meta.personas) ? meta.personas.map((x: any) => String(x)) : [],
    heroTemplate: meta.hero_template ?? null,
    heroPath: hasHeroMp4 ? path.join(folder, 'hero.mp4') : null,
    citationCount: Array.isArray(meta.citations) ? meta.citations.length : 0,
    artifacts: { hasPostMd, hasPostHtml, hasHeroHtml, hasHeroMp4, hasIgCarousel, hasTiktokScript, hasTwitterThread },
    freshness: freshnessFor(mtime),
    mtime,
    approvedByPersona: meta.approved_by_persona ?? null,
    publishedAt: typeof meta.published_at === 'number' ? meta.published_at : null,
  };
}

export function listDrafts(): DraftSummary[] {
  if (cache && cache.expires > Date.now()) return cache.items;
  const items: DraftSummary[] = [];
  if (fs.existsSync(DRAFTS_ROOT)) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(DRAFTS_ROOT); } catch { /* fine */ }
    for (const slug of entries) {
      // Skip dotfiles + hidden
      if (slug.startsWith('.') || slug.startsWith('_')) continue;
      const s = scanFolder(DRAFTS_ROOT, slug, false);
      if (s) items.push(s);
    }
  }
  // Sort newest mtime first so the row shows the freshest left
  items.sort((a, b) => b.mtime - a.mtime);
  cache = { items, expires: Date.now() + SCAN_TTL_MS };
  return items;
}

export function listPublished(limit = 10): DraftSummary[] {
  if (!fs.existsSync(PUBLISHED_ROOT)) return [];
  const out: DraftSummary[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(PUBLISHED_ROOT); } catch { return []; }
  for (const slug of entries) {
    if (slug.startsWith('.') || slug.startsWith('_')) continue;
    const s = scanFolder(PUBLISHED_ROOT, slug, true);
    if (s) out.push(s);
  }
  out.sort((a, b) => (b.publishedAt ?? b.mtime) - (a.publishedAt ?? a.mtime));
  return out.slice(0, limit);
}

export function invalidateDraftsCache(): void { cache = null; }

export function openDraftFolderInExplorer(slug: string): { ok: boolean; error?: string } {
  // Look up by display slug — a slight inconvenience because the folder name
  // includes the date prefix. Find the folder whose meta.slug matches OR
  // whose folder name ends with the slug.
  const drafts = listDrafts();
  const match = drafts.find(d => d.slug === slug || d.folderPath.endsWith(slug));
  if (!match) return { ok: false, error: `unknown draft: ${slug}` };
  try {
    shell.openPath(match.folderPath);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function openHeroInPlayer(slug: string): { ok: boolean; error?: string } {
  const drafts = listDrafts();
  const match = drafts.find(d => d.slug === slug || d.folderPath.endsWith(slug));
  if (!match || !match.heroPath) return { ok: false, error: 'hero.mp4 not found for this draft' };
  try {
    shell.openPath(match.heroPath);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
