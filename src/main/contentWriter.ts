// Content writer — LLM passes that turn a queue topic into draft artefacts.
//
// Three stages:
//   1. draftPost     — research via consultAdvisor on the topic's personas,
//                       then Sonnet writes the post body in FXV voice. Returns
//                       both markdown (for editing) and body_html (for the
//                       blog template substitution). Citations come back as
//                       a structured array we drop into meta.json.
//   2. draftHeroSpec — Sonnet pass that fills the topic-specific variables
//                       for the chosen hero template (FORMULA_HTML,
//                       INPUTS_HTML, RESULT_VALUE, etc.).
//   3. draftSocialBundles — three Haiku passes (IG, TikTok, Twitter) all
//                       built from the post markdown. Cheap, fire in parallel.
//
// All stages return strict JSON so the orchestrator can map → files.
//
// Brand rules enforced via SYSTEM prompts:
//   - no emoji anywhere
//   - gradient on data viz only (so hero composition gradient = ok, post
//     prose gradient = not ok — handled at template level)
//   - bespoke geometric SVG diagrams for in-post visuals
//   - audience: hybrid athletes (Hyrox / triathlon / CrossFit / fire / military)
//   - voice: confident, evidence-first, no hype, no exclamation marks

import { AnthropicProvider } from './providers/anthropic';
import { consultAdvisor } from './advisors';

export interface QueueTopic {
  title: string;
  slug: string;
  personas: string[];
  hero_template: string;
  key_question: string;
  audience: string;
  priority: string;
}

export interface PostCitation {
  id: number;
  ref: string;          // "Wilson JM, Marin PJ ... J Strength Cond Res. 2012;26(8):2293-2307."
  pmid: string | null;  // PubMed id (digits only) or null for non-PubMed sources
}

export interface DraftedPost {
  title: string;            // refined title (LLM may tighten the queue title)
  slug: string;
  description: string;      // 1-line meta description for OG / search
  intro: string;            // single-paragraph intro (sits in blog-post-intro)
  category: string;
  read_time: number;
  markdown: string;         // post.md body
  body_html: string;        // ready for blog.html {{body_html}} substitution
  citations: PostCitation[];
  tags: string[];
}

export interface HeroFormulaSpec {
  template: 'hero-formula';
  TITLE: string;
  SUBTITLE: string;
  FORMULA_HTML: string;
  TERM_COUNT: number;
  INPUTS_TITLE: string;
  INPUTS_HTML: string;
  RESULT_LABEL: string;
  RESULT_VALUE: number;
  RESULT_UNITS: string;
}
export interface HeroQuoteSpec {
  template: 'hero-quote';
  KICKER: string;
  QUOTE_HTML: string;
  ATTRIBUTION: string;
  TAKEAWAY: string;
}
export interface HeroStatSpec {
  template: 'hero-stat';
  KICKER: string;
  STAT_VALUE: string | number;
  STAT_UNIT: string;
  STAT_IS_INT: boolean;
  HEADLINE: string;
  BODY: string;
  ATTRIBUTION: string;
}
export type HeroSpec = HeroFormulaSpec | HeroQuoteSpec | HeroStatSpec;

export interface SocialBundle {
  igCarousel: any;          // structured object — see ig-carousel.json shape
  tiktokScript: string;     // markdown
  twitterThread: string;    // markdown
}

// ---- Shared writing voice ----------------------------------------------

const FXV_VOICE_RULES = `FXV brand voice rules — these are non-negotiable:
- Confident and evidence-first. Cite primary sources. Never hype.
- NO emoji. Anywhere. Including section headings.
- NO exclamation marks. Calm, direct prose.
- Audience: hybrid athletes (Hyrox / triathlon / CrossFit / military / fire). Not research-only readers.
- Sentences should land. Cut filler. Don't say "in this article" or "let's dive in".
- Cite as [N] inline using the citations array order. Every factual claim that comes from a paper needs [N].
- British English spellings (polarised, prioritise, behaviour, programme).
- Heading style: <h2> only, sentence-case, no all-caps.`;

// ---- Stage 1: draftPost -------------------------------------------------

export interface DraftPostInput {
  topic: QueueTopic;
  // Optional: pre-gathered research from advisors. If omitted the writer
  // calls consultAdvisor on the topic's personas itself.
  preGatheredResearch?: { personaId: string; reply: string; sources: { index: number; label: string; score: number }[] }[];
  onProgress?: (line: string) => void;
}

export async function draftPost(input: DraftPostInput): Promise<DraftedPost> {
  const log = (s: string) => input.onProgress?.(s);
  const research = input.preGatheredResearch ?? [];

  if (research.length === 0) {
    log(`[research] consulting ${input.topic.personas.length} specialist(s)...`);
    for (const personaId of input.topic.personas) {
      log(`[research]   asking ${personaId}...`);
      try {
        const q = `Research dump for a blog post on: "${input.topic.title}". Key question we're answering for the reader: "${input.topic.key_question}". Audience: ${input.topic.audience}. Give me the strongest 4-6 evidence-grounded claims you'd want a writer to use, with citations, sticking to YOUR domain. Don't write the post — just the cited claims, one per bullet, with author/year + PMID where available. If a claim isn't in your sources, skip it.`;
        const r = await consultAdvisor(personaId, q, []);
        research.push({ personaId, reply: r.reply, sources: r.sources });
      } catch (err: any) {
        log(`[research]   ${personaId} failed: ${err?.message ?? err}`);
      }
    }
  }

  log(`[draft] writing post (Sonnet)...`);
  const provider = new AnthropicProvider();

  const researchBlock = research.map(r =>
    `### ${r.personaId} replied:\n${r.reply}\n\nSources cited:\n${r.sources.map(s => `[${s.index}] ${s.label} (score ${s.score.toFixed(2)})`).join('\n')}`
  ).join('\n\n---\n\n');

  const systemPrompt = `You are FXV's content writer. You produce evidence-grounded blog posts in FXV's voice for hybrid athletes.

${FXV_VOICE_RULES}

Output ONLY a single JSON object with these fields:
{
  "title": "tight, specific. Often a refinement of the input title.",
  "description": "single sentence under 160 chars for OG meta tag",
  "intro": "single paragraph (no <p> wrapper), ~50-80 words, sits in the blog-post-intro slot. Hooks the reader.",
  "category": "Programming | Recovery | Strength | Methodology | Concurrent | Aerobic — pick the best fit",
  "read_time": <integer minutes — count words in markdown / 200>,
  "markdown": "the full post body in markdown. ~1000-1400 words. Use ## for sections (no #1). Cite as [N]. End with a 'How FXV applies this' section that ties to the methodology page where appropriate.",
  "body_html": "the same content as HTML for the blog template. Use <p> for paragraphs, <h2> for sections, <strong> for emphasis, <ul><li> for lists. Cite as [N]. NO <h1> (the template has it). NO <html>/<body> wrappers — just the inner block-level elements. The first paragraph here should mirror the markdown's first paragraph.",
  "citations": [
    { "id": 1, "ref": "Author A, Author B. Title. Journal. Year;Vol(Issue):Pages.", "pmid": "12345678 or null" }
  ],
  "tags": ["short", "kebab-case", "tags"]
}

Rules:
- Citations array order MUST match [N] usage in body_html / markdown.
- Only include citations actually referenced in the post.
- If the research bundle has gaps, write less rather than guessing.
- 1000-1400 words is the target. Below 800 = too thin. Above 1500 = too long.`;

  const userPrompt = `TOPIC: ${input.topic.title}
KEY QUESTION: ${input.topic.key_question}
AUDIENCE: ${input.topic.audience}
SLUG: ${input.topic.slug}

RESEARCH BUNDLE FROM SPECIALISTS:

${researchBlock}

Write the post per the system instructions. Return JSON only.`;

  const r = await provider.run('claude-sonnet-4-6', {
    systemPrompt,
    prompt: userPrompt,
    noTools: true,
    maxTurns: 1,
  }, { _agentId: 'content:writer' } as any);

  const text = r.text.trim();
  // Tolerant JSON extraction — model sometimes wraps in ```json fences
  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let parsed: any;
  try { parsed = JSON.parse(jsonText); }
  catch (err) {
    // One more attempt: extract the largest balanced { ... } block
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('post writer returned no JSON: ' + text.slice(0, 200));
    parsed = JSON.parse(m[0]);
  }

  log(`[draft] post drafted: ${parsed.title} (~${parsed.read_time} min, ${(parsed.citations || []).length} citations)`);

  return {
    title: String(parsed.title ?? input.topic.title),
    slug: input.topic.slug,
    description: String(parsed.description ?? ''),
    intro: String(parsed.intro ?? ''),
    category: String(parsed.category ?? 'Programming'),
    read_time: Number(parsed.read_time ?? 6),
    markdown: String(parsed.markdown ?? ''),
    body_html: String(parsed.body_html ?? ''),
    citations: Array.isArray(parsed.citations) ? parsed.citations.map((c: any, i: number) => ({
      id: typeof c.id === 'number' ? c.id : i + 1,
      ref: String(c.ref ?? ''),
      pmid: c.pmid ? String(c.pmid).replace(/[^0-9]/g, '') || null : null,
    })) : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((t: any) => String(t)) : [],
  };
}

// ---- Stage 2: draftHeroSpec --------------------------------------------

export async function draftHeroSpec(topic: QueueTopic, post: DraftedPost, onProgress?: (s: string) => void): Promise<HeroSpec> {
  onProgress?.(`[hero] generating ${topic.hero_template} spec (Sonnet)...`);
  const provider = new AnthropicProvider();

  const systemPrompt = `You produce the variable-substitution spec for a Hyperframes hero composition. The composition is a 1080×1920 vertical video that summarises the blog post for IG / TikTok / Twitter.

${FXV_VOICE_RULES}

You will be told which template to fill (hero-formula, hero-quote, or hero-stat). Output ONLY a single JSON object with the exact variable names for that template.

For hero-formula:
{
  "template": "hero-formula",
  "TITLE": "BIG short word/phrase — usually a number or acronym (max ~10 chars; renders at 200-280px)",
  "SUBTITLE": "1 line context, max ~50 chars",
  "FORMULA_HTML": "the formula as inline HTML. Wrap each visible token in <span class=\\"term lhs|op|coef|var\\" id=\\"t-N\\">…</span> with sequential ids t-1, t-2 … t-K. Use 'lhs' for variable names, 'op' for operators (+, ×, =, /), 'coef' for numbers/percentages. Example: <span class=\\"term lhs\\" id=\\"t-1\\">EASY</span><span class=\\"term op\\" id=\\"t-2\\">+</span><span class=\\"term lhs\\" id=\\"t-3\\">HARD</span>",
  "TERM_COUNT": <integer count of <span class=\\"term…\\"> elements above>,
  "INPUTS_TITLE": "label for the worked-example panel, max ~50 chars",
  "INPUTS_HTML": "rows of <div class=\\"inputs-row\\"><span class=\\"k\\">Label</span><span class=\\"v\\">Value</span></div>. 4 rows, ~30 chars each side max",
  "RESULT_LABEL": "label above the big number, max ~30 chars",
  "RESULT_VALUE": <integer — the counter animates from 0 to this>,
  "RESULT_UNITS": "1 line under the big number, max ~70 chars"
}

For hero-quote:
{
  "template": "hero-quote",
  "KICKER": "all-caps tag, max 24 chars (e.g. 'MYTH' or 'EVIDENCE SAYS')",
  "QUOTE_HTML": "the bold claim as HTML. Wrap key terms in <em class=\\"brand\\">…</em> for gradient highlight. ~14-22 words. ~96px font means line-length is critical.",
  "ATTRIBUTION": "small italic line, max ~70 chars (e.g. 'Wilson 2012 · 21-study meta-analysis')",
  "TAKEAWAY": "the practical 'what this means for you' sentence, max ~120 chars"
}

For hero-stat:
{
  "template": "hero-stat",
  "KICKER": "all-caps context line, max 30 chars (e.g. 'ON A 7-DAY ROLLING BASELINE')",
  "STAT_VALUE": "the number or short string. If pure integer animate counter from 0; else show as-is.",
  "STAT_UNIT": "max ~6 chars (% / ms / days / kJ / TRIMP)",
  "STAT_IS_INT": <true if STAT_VALUE is a pure integer that should counter-animate, else false>,
  "HEADLINE": "single line context above the stat, max ~80 chars",
  "BODY": "2-3 sentences below the stat explaining the 'so what'",
  "ATTRIBUTION": "small italic line, max ~70 chars"
}

Length matters — text overflows the visual frame if you exceed the suggested character counts.`;

  const userPrompt = `TEMPLATE TO FILL: ${topic.hero_template}

POST TITLE: ${post.title}
POST INTRO: ${post.intro}

POST BODY (markdown, for context):
${post.markdown.slice(0, 3000)}

KEY QUESTION the post answers: ${topic.key_question}

Output the JSON spec for the ${topic.hero_template} template. Return JSON only.`;

  const r = await provider.run('claude-sonnet-4-6', {
    systemPrompt,
    prompt: userPrompt,
    noTools: true,
    maxTurns: 1,
  }, { _agentId: 'content:hero-spec' } as any);

  const text = r.text.trim();
  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let parsed: any;
  try { parsed = JSON.parse(jsonText); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('hero spec returned no JSON: ' + text.slice(0, 200));
    parsed = JSON.parse(m[0]);
  }
  // Force template field to match the topic — model sometimes drifts
  parsed.template = topic.hero_template;
  return parsed as HeroSpec;
}

// ---- Stage 3: draftSocialBundles ---------------------------------------

export async function draftSocialBundles(topic: QueueTopic, post: DraftedPost, onProgress?: (s: string) => void): Promise<SocialBundle> {
  onProgress?.('[social] drafting IG / TikTok / Twitter bundles in parallel (Haiku)...');
  const provider = new AnthropicProvider();

  // Bound the post snippet we send to keep token costs honest.
  const postSnippet = post.markdown.slice(0, 4000);

  // IG carousel — structured JSON
  const igPromise = provider.run('claude-haiku-4-5-20251001', {
    systemPrompt: `You produce a 6-frame Instagram / LinkedIn carousel as JSON, in FXV voice. ${FXV_VOICE_RULES}\n\nOutput ONLY JSON:\n{\n  "post_caption": "200-400 char caption with one or two paragraph breaks. End with 4-7 hashtags.",\n  "frames": [\n    { "n": 1, "kind": "title", "headline": "...", "subline": "...", "footer": "FXV Performance · ..." },\n    { "n": 2, "kind": "stat" | "claim" | "comparison" | "weekly-shape" | "cta", ...frame-specific fields },\n    ...\n  ],\n  "alt_text": "single-sentence alt text for accessibility"\n}\n\nFrame 1 = title. Frame 6 = CTA pointing to fxvperformance.com/blog. Frames 2-5 = the substantive ideas — be concrete, lead with a number or claim per frame.`,
    prompt: `POST TITLE: ${post.title}\n\nPOST INTRO: ${post.intro}\n\nPOST BODY:\n${postSnippet}\n\nReturn JSON only.`,
    noTools: true,
    maxTurns: 1,
  }, { _agentId: 'content:ig' } as any);

  // TikTok script — markdown
  const tiktokPromise = provider.run('claude-haiku-4-5-20251001', {
    systemPrompt: `You write 60-second TikTok / Reels voice-over scripts for FXV. ${FXV_VOICE_RULES}\n\nOutput a markdown script with these sections in order: Hook (0-4s), Setup (4-14s), Tension (14-28s), Resolution (28-48s), Payoff (48-60s). For each section put the spoken voice-over in > blockquotes and add VISUAL: notes for what's on screen (the hero.mp4 plays in background, lightly desaturated). End with a short Caption section (under the post) and a Voice notes section for delivery.`,
    prompt: `POST TITLE: ${post.title}\n\nPOST BODY:\n${postSnippet}\n\nReturn the script as markdown only.`,
    noTools: true,
    maxTurns: 1,
  }, { _agentId: 'content:tiktok' } as any);

  // Twitter thread — markdown
  const twitterPromise = provider.run('claude-haiku-4-5-20251001', {
    systemPrompt: `You write Twitter / X threads for FXV — 5 to 7 tweets, each under 280 chars. ${FXV_VOICE_RULES}\n\nThread structure:\n  1. Hook tweet (attaches hero.mp4)\n  2. Definitions / setup\n  3-5. The substantive ideas with citations\n  6. The hybrid-athlete wedge (or topic-specific punchline)\n  7. CTA pointing to the blog post URL\n\nFormat as markdown with each tweet under '**Tweet N / what**' headers. Lead with the hook. End with a 'Notes' section listing any constraints (attaches hero.mp4 to tweet 1, etc.).`,
    prompt: `POST TITLE: ${post.title}\n\nPOST BODY:\n${postSnippet}\n\nBlog URL: fxvperformance.com/blog/${post.slug}\n\nReturn markdown only.`,
    noTools: true,
    maxTurns: 1,
  }, { _agentId: 'content:twitter' } as any);

  const [igRaw, tiktokRaw, twitterRaw] = await Promise.all([igPromise, tiktokPromise, twitterPromise]);

  // Parse IG JSON
  let igCarousel: any;
  try {
    const t = igRaw.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    igCarousel = JSON.parse(t);
  } catch {
    const m = igRaw.text.match(/\{[\s\S]*\}/);
    igCarousel = m ? JSON.parse(m[0]) : { post_caption: '', frames: [], alt_text: '' };
  }

  return {
    igCarousel,
    tiktokScript: tiktokRaw.text.trim(),
    twitterThread: twitterRaw.text.trim(),
  };
}
