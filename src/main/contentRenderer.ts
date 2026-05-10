// Content renderer — turns DraftedPost + HeroSpec into on-disk artefacts.
//
// Pure-text substitution (no template engine). The blog template uses
// {{name}} placeholders and a single {{#if citations}} ... {{/if}} block.
// Hero templates use {{NAME}} placeholders only.
//
// renderHeroMp4 spawns hyperframes via the existing fxv-videos project as
// the working directory — fxv-videos already has hyperframes configured,
// node_modules ready, ffmpeg discoverable, and we don't want every draft
// to need its own scaffold. We swap fxv-videos/index.html with the draft's
// hero.html for the duration of the render.

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { DraftedPost, HeroSpec, PostCitation, SocialBundle } from './contentWriter';

const FXV_CONTENT_ROOT = 'C:/Users/Fusion/fxv-content';
const FXV_VIDEOS_ROOT = 'C:/Users/Fusion/fxv-videos';
const FFMPEG_BIN_DEFAULT = 'C:/Users/Fusion/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build/bin';

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(FXV_CONTENT_ROOT, 'templates', name), 'utf8');
}

// Tolerant {{name}} substitution. Unknown placeholders are left in place
// so a caller can spot them in the rendered output.
function substitute(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (full, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name];
      return v == null ? '' : String(v);
    }
    return full;
  });
}

// {{#if citations}} ... {{/if}} — keep the inner block if 'citations' truthy
function applyConditionals(template: string, conditions: Record<string, boolean>): string {
  return template.replace(/\{\{#if\s+([A-Za-z_][A-Za-z0-9_]*)\s*\}\}([\s\S]*?)\{\{\/if\s*\}\}/g, (_full, name, inner) => {
    return conditions[name] ? inner : '';
  });
}

// ---- Blog HTML rendering -----------------------------------------------

function renderCitationsHtml(citations: PostCitation[]): string {
  if (!citations.length) return '';
  return citations.map(c => {
    const ref = c.ref;
    const pmid = c.pmid
      ? ` PMID: <a href="https://pubmed.ncbi.nlm.nih.gov/${c.pmid}" style="color:#888;">${c.pmid}</a>`
      : '';
    return `          <li>${escapeMinimal(ref)}${pmid}</li>`;
  }).join('\n');
}

// HTML-escape <, >, & — but NOT quotes, since `ref` may contain them legitimately
function escapeMinimal(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDateForBlog(iso: string): string {
  // Blog uses "May 12, 2026" — convert from ISO YYYY-MM-DD
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export function renderPostHtml(post: DraftedPost, isoDate: string): string {
  const template = readTemplate('blog.html');
  const withConds = applyConditionals(template, { citations: post.citations.length > 0 });
  const citationsHtml = renderCitationsHtml(post.citations);
  return substitute(withConds, {
    title: post.title,
    description: post.description,
    slug: post.slug,
    date: formatDateForBlog(isoDate),
    category: post.category,
    read_time: post.read_time,
    intro: post.intro,
    body_html: post.body_html,
    citations_html: citationsHtml,
  });
}

// ---- Hero composition rendering ----------------------------------------

function templateForHero(template: string): string {
  return readTemplate(`${template}.html`);
}

export function renderHeroComposition(spec: HeroSpec): string {
  const template = templateForHero(spec.template);
  // Convert spec object into vars Record. Skip 'template' field itself.
  const { template: _t, ...rest } = spec as any;
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(rest)) {
    vars[k] = (typeof v === 'number' || typeof v === 'string') ? v : (typeof v === 'boolean' ? String(v) : JSON.stringify(v));
  }
  return substitute(template, vars);
}

// ---- Hero MP4 render (spawns hyperframes) ------------------------------

interface HyperframesRunResult {
  ok: boolean;
  outputPath: string | null;
  log: string[];
  error?: string;
}

export async function renderHeroMp4(opts: {
  heroHtmlContents: string;
  outputMp4Path: string;
  onLine?: (line: string) => void;
}): Promise<HyperframesRunResult> {
  const log: string[] = [];
  const onLine = (line: string) => { log.push(line); opts.onLine?.(line); };

  if (!fs.existsSync(FXV_VIDEOS_ROOT)) {
    return { ok: false, outputPath: null, log, error: `fxv-videos root not found: ${FXV_VIDEOS_ROOT}` };
  }

  const indexPath = path.join(FXV_VIDEOS_ROOT, 'index.html');
  // Snapshot existing index.html so we can restore it after the render.
  let backup: string | null = null;
  try { backup = fs.readFileSync(indexPath, 'utf8'); } catch { backup = null; }

  try {
    fs.writeFileSync(indexPath, opts.heroHtmlContents, 'utf8');
    onLine('[render] hero.html written into fxv-videos/index.html');
    onLine('[render] running hyperframes render...');

    // Resolve ffmpeg into PATH for the spawned process. The Gyan winget install
    // doesn't update PATH for already-running shells.
    const ffmpegBin = process.env.HIVE_FFMPEG_BIN || FFMPEG_BIN_DEFAULT;
    const childEnv = { ...process.env };
    if (fs.existsSync(ffmpegBin)) {
      childEnv.PATH = ffmpegBin + path.delimiter + (childEnv.PATH || '');
    }

    // Ensure output dir exists
    fs.mkdirSync(path.dirname(opts.outputMp4Path), { recursive: true });

    const result = await new Promise<HyperframesRunResult>((resolve) => {
      const child = spawn('npx', ['--yes', 'hyperframes@0.5.6', 'render', '--output', opts.outputMp4Path], {
        cwd: FXV_VIDEOS_ROOT,
        shell: true,
        windowsHide: true,
        env: childEnv,
      });
      let stderr = '';
      child.stdout?.on('data', (b: Buffer) => {
        for (const line of b.toString().split(/\r?\n/)) if (line.trim()) onLine(line);
      });
      child.stderr?.on('data', (b: Buffer) => {
        const chunk = b.toString();
        stderr += chunk;
        for (const line of chunk.split(/\r?\n/)) if (line.trim()) onLine(line);
      });
      // Timeout: hero render is normally 60-120s. Cap at 5 min.
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* fine */ }
      }, 5 * 60_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, outputPath: null, log, error: err?.message ?? String(err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(opts.outputMp4Path)) {
          resolve({ ok: true, outputPath: opts.outputMp4Path, log });
        } else {
          resolve({ ok: false, outputPath: null, log, error: `hyperframes exited ${code}: ${stderr.trim().slice(-300)}` });
        }
      });
    });

    return result;
  } finally {
    // Always restore the backup so fxv-videos isn't left with a stale draft
    if (backup != null) {
      try { fs.writeFileSync(indexPath, backup, 'utf8'); } catch { /* fine */ }
    }
  }
}

// ---- Draft folder writer ------------------------------------------------

export interface DraftWriteOpts {
  topic: import('./contentWriter').QueueTopic;
  post: DraftedPost;
  postHtml: string;
  heroSpec: HeroSpec;
  heroHtml: string;
  heroMp4Path: string | null;
  social: SocialBundle;
  isoDate: string;            // YYYY-MM-DD
}

export function writeDraftFolder(opts: DraftWriteOpts): string {
  const folderName = `${opts.isoDate}-${opts.topic.slug}`;
  const folder = path.join(FXV_CONTENT_ROOT, 'drafts', folderName);
  fs.mkdirSync(folder, { recursive: true });

  fs.writeFileSync(path.join(folder, 'post.md'), `# ${opts.post.title}\n\n${opts.post.markdown}\n`, 'utf8');
  fs.writeFileSync(path.join(folder, 'post.html'), opts.postHtml, 'utf8');
  fs.writeFileSync(path.join(folder, 'hero.html'), opts.heroHtml, 'utf8');
  fs.writeFileSync(path.join(folder, 'ig-carousel.json'), JSON.stringify(opts.social.igCarousel, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(folder, 'tiktok-script.md'), opts.social.tiktokScript + '\n', 'utf8');
  fs.writeFileSync(path.join(folder, 'twitter-thread.md'), opts.social.twitterThread + '\n', 'utf8');

  // hero.mp4 is already at heroMp4Path (we wrote it directly there during render).
  // If the render failed, no mp4 to write.

  const meta = {
    title: opts.post.title,
    slug: opts.topic.slug,
    date: opts.isoDate,
    category: opts.post.category,
    read_time: opts.post.read_time,
    description: opts.post.description,
    intro: opts.post.intro,
    personas: opts.topic.personas,
    hero_template: opts.topic.hero_template,
    hero_renderer_vars: (() => {
      const { template: _t, ...rest } = opts.heroSpec as any;
      return rest;
    })(),
    citations: opts.post.citations,
    tags: opts.post.tags,
    primary_audience: opts.topic.audience,
    key_question: opts.topic.key_question,
    approved_by_persona: null,
    rendered_at: opts.heroMp4Path ? Date.now() : null,
    published_at: null,
    generated_by: 'hive:contentPipeline',
  };
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

  return folder;
}
