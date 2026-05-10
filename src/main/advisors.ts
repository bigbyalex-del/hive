// FXV advisor agents — domain specialists you can chat with directly.
//
// Each persona owns a slice of FXV (Aerobic, Strength, Concurrent, Load,
// Readiness, Coach, Testing, UI/UX, Marketing). Memory is seeded by
// scripts/seed-fxv-personas.ts into per-persona chunks at project_id=NULL.
//
// Anti-hallucination layers:
//   1. Recall-first — every reply pulls top-K chunks before generation.
//   2. Sources injected as numbered <sources> blocks; SYSTEM rule says
//      "answer only from sources, cite as [N], else say no source".
//   3. Citation linter (Haiku) checks every claim has a [N]. If missing, we
//      re-prompt the model once to rewrite with citations.
//   4. Scope policing — persona refuses + routes out-of-domain questions.

import * as fs from 'fs';
import * as path from 'path';

import { embed } from './memory';
import { loadChunks, recordRun, insertChat } from './db';
import { AnthropicProvider } from './providers/anthropic';

interface Persona {
  id: string;
  name: string;
  title: string;
  scope: string;
  routes_to?: Record<string, string>;
  system_prompt: string;
  seed_globs: string[];
  isManager?: boolean;
  isPage?: boolean;
}
interface PersonasFile {
  fxvRepoPath: string;
  sharedAgentId: string;
  sharedSeedGlobs: string[];
  personas: Persona[];
}

let cached: PersonasFile | null = null;

function personasPath(): string {
  return path.join(__dirname, '..', '..', 'personas.json');
}

export function loadPersonas(): PersonasFile {
  if (cached) return cached;
  const raw = fs.readFileSync(personasPath(), 'utf8');
  cached = JSON.parse(raw) as PersonasFile;
  return cached;
}

export function listAdvisors(): { id: string; name: string; title: string; scope: string; isManager: boolean; isPage: boolean }[] {
  return loadPersonas().personas.map(p => ({
    id: p.id,
    name: p.name,
    title: p.title,
    scope: p.scope,
    isManager: !!p.isManager,
    isPage: !!p.isPage,
  }));
}

function findPersona(id: string): Persona | null {
  return loadPersonas().personas.find(p => p.id === id) ?? null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Source {
  index: number;
  tag: string | null;
  content: string;
  score: number;
  agentId: string;
}

async function recallForAdvisor(persona: Persona, sharedId: string, query: string, limit: number): Promise<Source[]> {
  // Pure-JS cosine search. Specialists pull from their own namespace +
  // shared. Manager pulls from EVERY specialist's namespace + shared so it
  // can synthesise across domains. project_id IS NULL = advisor pool, not
  // tied to a Hive project.
  const allPersonas = loadPersonas().personas;
  // Manager pulls from every other persona's namespace (specialists + page
  // agents) plus the shared FXV pool, so it can synthesise across the whole
  // app. Specialists + page agents pull from their own namespace + shared.
  const namespaces: string[] = persona.isManager
    ? [...allPersonas.filter(p => !p.isManager).map(p => p.id), sharedId]
    : [persona.id, sharedId];

  const rows: { tag: string | null; content: string; embedding: number[]; agentId: string }[] = [];
  for (const ns of namespaces) {
    for (const r of loadChunks(ns)) {
      rows.push({ ...r, agentId: ns });
    }
  }
  if (rows.length === 0) return [];

  const qvec = await embed(query);
  const scored = rows.map(r => ({
    tag: r.tag,
    content: r.content,
    agentId: r.agentId,
    score: cosine(qvec, r.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  // Source-diversity cap: at most 2 chunks per file. Stops one verbose file
  // (e.g. methodology.html with many similar paragraphs) from dominating the
  // K slots and starving more relevant but smaller files. Manager pulls
  // wider since it weaves perspectives; specialists got bumped 6→10 after
  // we saw exercise-db.ts get out-ranked by methodology on broad questions.
  const cap = persona.isManager ? Math.max(limit, 16) : Math.max(limit, 10);
  const perFileCap = 2;
  const fileCounts = new Map<string, number>();
  const diverse: typeof scored = [];
  for (const s of scored) {
    if (diverse.length >= cap) break;
    const fileKey = s.tag?.startsWith('src:') ? s.tag.slice(4).split('#')[0] : (s.tag ?? 'unknown');
    const used = fileCounts.get(fileKey) ?? 0;
    if (used >= perFileCap) continue;
    fileCounts.set(fileKey, used + 1);
    diverse.push(s);
  }
  return diverse.slice(0, Math.max(1, Math.min(20, cap))).map((r, i) => ({
    index: i + 1,
    tag: r.tag,
    content: r.content,
    score: r.score,
    agentId: r.agentId,
  }));
}

function specialistLabel(agentId: string): string {
  // 'fxv:aerobic' -> 'Aerobic' so the Manager can attribute by name.
  const personas = loadPersonas().personas;
  const found = personas.find(p => p.id === agentId);
  if (found) return found.name;
  if (agentId === loadPersonas().sharedAgentId) return 'Shared';
  return agentId;
}

function buildSystemPrompt(persona: Persona, sources: Source[]): string {
  const sourcesBlock = sources.length === 0
    ? '<sources>\n(no relevant sources retrieved — you have no grounded material to cite for this question)\n</sources>'
    : '<sources>\n' + sources.map(s => {
        const path = s.tag?.startsWith('src:') ? s.tag.slice(4).split('#')[0] : (s.tag ?? 'unknown');
        const owner = persona.isManager ? `(${specialistLabel(s.agentId)}) ` : '';
        const body = s.content.length > 1800 ? s.content.slice(0, 1800) + '\n[truncated]' : s.content;
        return `[${s.index}] ${owner}${path}\n${body}`;
      }).join('\n\n---\n\n') + '\n</sources>';

  const routes = persona.routes_to
    ? '\n\nROUTING TABLE — when the question is outside your scope, route to the right agent:\n' +
      Object.entries(persona.routes_to).map(([topic, target]) => `  • ${topic} → ${target}`).join('\n')
    : '';

  return `${persona.system_prompt}

GROUNDING RULES (must follow):
1. Use ONLY the numbered sources below to support factual claims. After every fact, write its citation as [N] where N is the source index.
2. If the sources do not cover the question, write exactly: "I don't have a grounded source for this — would be guessing." Then suggest who to ask.
3. Do not invent file paths, function names, or numbers that are not in the sources.
4. Keep replies tight: 2–4 sentences unless asked for more depth.${routes}

${sourcesBlock}`;
}

// Minimal claim-citation linter. Splits the reply into sentences and flags
// any sentence that asserts something concrete but has no [N]. Headers,
// list-marker lines, refusals, self-introductions, and routing meta-
// statements are exempt — they're not factual claims about FXV.
function lintCitations(reply: string, sourceCount: number): { ok: boolean; missing: string[] } {
  if (sourceCount === 0) return { ok: true, missing: [] }; // nothing to cite
  const missing: string[] = [];
  const refusal = /grounded source|would be guessing|don'?t have/i;
  // Routing meta — sentences that just point the user at another agent.
  const routing = /\b(route to|talk to|ask the|ask fxv:|head over to|reach out to|for .{0,40}\bspecialist\b|for .{0,40}\bpage\b|for .{0,80}\bquestions?\b)/i;
  // Self-introductions — what the agent is, what it can do.
  const selfId = /^(I'?m |I'?ll |I can |I have |I own |I know |I focus |I'?d |My (job|role|scope))/i;
  const sentences = reply
    .replace(/```[\s\S]*?```/g, ' ') // strip code fences
    .split(/(?<=[.!?])\s+/);
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length < 25) continue; // too short to carry a factual claim
    if (refusal.test(s)) continue;
    if (/^[#\-*•]/.test(s)) continue; // header / list bullet
    if (selfId.test(s)) continue;
    // Routing-only meta is exempt UNLESS it carries a number / unit / domain
    // term that suggests a factual training-science claim alongside.
    if (routing.test(s) && !/\d|%|kJ|TRIMP|HRV|Z\d|\bRPE\b|\bRMSSD\b|\b1RM\b/i.test(s)) continue;
    if (/^(I |You |Your |We |Let me |Sure|Here'?s|Note that|To clarify)/i.test(s) && !/\d|%|kJ|TRIMP|HRV|Z\d/.test(s)) continue;
    if (!/\[\d+\]/.test(s)) missing.push(s.slice(0, 140));
  }
  return { ok: missing.length === 0, missing };
}

export interface ConsultResult {
  reply: string;
  personaId: string;
  personaName: string;
  sources: { index: number; label: string; score: number }[];
  citationMissingCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ExtractedAction {
  summary: string;
  urgency: 'low' | 'medium' | 'high';
}

export async function consultAdvisor(
  personaId: string,
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
): Promise<ConsultResult> {
  const personasFile = loadPersonas();
  const persona = findPersona(personaId);
  if (!persona) throw new Error(`unknown advisor: ${personaId}`);
  const q = String(question ?? '').trim();
  if (!q) throw new Error('question is empty');

  // Use the latest user turn for retrieval; if there's prior history, lightly
  // append the previous user turn as context for the embedding query so
  // pronouns ("what about it?") resolve to the original topic.
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  const retrievalQuery = lastUser ? `${lastUser.content.slice(0, 200)}\n${q}` : q;
  const sources = await recallForAdvisor(persona, personasFile.sharedAgentId, retrievalQuery, 6);

  const systemPrompt = buildSystemPrompt(persona, sources);
  const provider = new AnthropicProvider();

  // Render history + new question as a single prompt. We don't need the full
  // multi-message format because there are no tool calls — Anthropic provider
  // wraps prompt as a single user message.
  const prompt = (history.length === 0)
    ? q
    : history.map(m => `${m.role === 'user' ? 'USER' : 'YOU'}: ${m.content}`).join('\n\n') + `\n\nUSER: ${q}`;

  // Default to Sonnet for advisors — they need to follow grounding rules and
  // route correctly, where Haiku sometimes drifts. Cost is fine: short
  // 2-4 sentence replies.
  const model = 'claude-sonnet-4-6';
  let inputTokens = 0;
  let outputTokens = 0;

  const first = await provider.run(model, {
    systemPrompt,
    prompt,
    noTools: true,
    maxTurns: 1,
  }, { _agentId: persona.id } as any);
  inputTokens += first.inputTokens;
  outputTokens += first.outputTokens;

  let reply = first.text;
  const lint = lintCitations(reply, sources.length);
  let citationMissingCount = lint.missing.length;

  if (!lint.ok && sources.length > 0) {
    const fixPrompt = `Your previous answer made factual claims without citing the numbered sources. Re-write your answer with [N] after every fact. Sentences missing citations:\n\n${lint.missing.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\nReply with the rewritten answer ONLY. Same brevity (2–4 sentences). If a claim genuinely has no source, replace it with "I don't have a grounded source for this — would be guessing."`;
    const second = await provider.run('claude-haiku-4-5-20251001', {
      systemPrompt,
      prompt: `${prompt}\n\nYOUR PREVIOUS DRAFT:\n${reply}\n\n${fixPrompt}`,
      noTools: true,
      maxTurns: 1,
    }, { _agentId: persona.id + ':lint' } as any);
    inputTokens += second.inputTokens;
    outputTokens += second.outputTokens;
    if (second.text.trim()) {
      reply = second.text.trim();
      const lint2 = lintCitations(reply, sources.length);
      citationMissingCount = lint2.missing.length;
    }
  }

  // Cost telemetry rolls into Hive's existing dashboard.
  recordRun({
    dispatchId: null,
    agentId: persona.id,
    model,
    inputTokens,
    outputTokens,
    status: 'done',
    summary: q.slice(0, 200),
    projectId: null,
  });

  const finalSources = sources.map(s => {
    const path = s.tag?.startsWith('src:') ? s.tag.slice(4).split('#')[0] : (s.tag ?? '(unknown)');
    const owner = persona.isManager ? specialistLabel(s.agentId) : null;
    return {
      index: s.index,
      label: owner ? `${owner} · ${path}` : path,
      score: s.score,
    };
  });

  // Persist the turn so cells + pulse + restart-resume see it.
  // User row first, then assistant — preserves chronological order in
  // listChatsForPersona (ORDER BY ts ASC).
  insertChat({ personaId: persona.id, role: 'user', content: q });
  insertChat({ personaId: persona.id, role: 'assistant', content: reply, sources: finalSources });

  // Note: action extraction is handled via a separate IPC call from the
  // renderer so the chat reply lands instantly and actions arrive a second
  // later — no extra blocking for the user.

  return {
    reply,
    personaId: persona.id,
    personaName: persona.name,
    sources: finalSources,
    citationMissingCount,
    inputTokens,
    outputTokens,
  };
}

// ---- Council mode ----
// Fan a question to every specialist + page agent in parallel, then have
// the Programme Lead synthesise consensus + dissent. Returns each agent's
// reply alongside the synthesis.

export interface CouncilParticipant {
  personaId: string;
  personaName: string;
  reply: string;
  sources: { index: number; label: string; score: number }[];
  citationMissingCount: number;
  error?: string;
}

export interface CouncilResult {
  question: string;
  participants: CouncilParticipant[];
  synthesis: string;
  synthesisSources: { index: number; label: string; score: number }[];
  totalInputTokens: number;
  totalOutputTokens: number;
}

export async function runCouncil(question: string): Promise<CouncilResult> {
  const personas = loadPersonas().personas;
  // Skip Manager — it runs the synthesis at the end, not as a participant.
  // Page agents participate so the council sees in-app implementation views
  // alongside training-science specialist views.
  const participants = personas.filter(p => !p.isManager);

  const results = await Promise.all(participants.map(async p => {
    try {
      const r = await consultAdvisor(p.id, question, []);
      return {
        personaId: p.id,
        personaName: p.name,
        reply: r.reply,
        sources: r.sources,
        citationMissingCount: r.citationMissingCount,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      };
    } catch (err: any) {
      return {
        personaId: p.id,
        personaName: p.name,
        reply: '',
        sources: [],
        citationMissingCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        error: err?.message ?? String(err),
      };
    }
  }));

  // Build synthesis prompt for the Manager — feed it each agent's reply as
  // a labelled block. Don't run the standard recall pass; the agents already
  // grounded their answers and we want synthesis, not new retrieval.
  const manager = personas.find(p => p.isManager);
  if (!manager) throw new Error('No manager persona configured for council synthesis');

  const synthesisInput = results.map(r =>
    `### ${r.personaName} (${r.personaId})\n${r.error ? `[error: ${r.error}]` : r.reply}`
  ).join('\n\n');

  const synthSystemPrompt = `You are FXV's Programme Lead synthesising a council of specialists' views on a single question. You will receive each specialist's answer in turn. Output: a tight 4-7 sentence synthesis that (a) names the consensus where it exists, (b) flags genuine dissent or contradictions, (c) gives Alex (FXV's developer) a recommended next move. Do NOT invent facts not in the council replies. Reference specialists by name where useful (e.g. "Aerobic and Concurrent agree…"). Skip empty / errored agents.`;

  const synthUserPrompt = `QUESTION: ${question}\n\nCOUNCIL REPLIES:\n\n${synthesisInput}`;

  const provider = new AnthropicProvider();
  let synthText = '';
  let synthIn = 0, synthOut = 0;
  try {
    const synth = await provider.run('claude-sonnet-4-6', {
      systemPrompt: synthSystemPrompt,
      prompt: synthUserPrompt,
      noTools: true,
      maxTurns: 1,
    }, { _agentId: 'council-synth' } as any);
    synthText = synth.text;
    synthIn = synth.inputTokens;
    synthOut = synth.outputTokens;
  } catch (err: any) {
    synthText = `(synthesis failed: ${err?.message ?? String(err)})`;
  }

  const totalInputTokens = synthIn + results.reduce((a, b) => a + b.inputTokens, 0);
  const totalOutputTokens = synthOut + results.reduce((a, b) => a + b.outputTokens, 0);

  recordRun({
    dispatchId: null,
    agentId: 'council',
    model: 'claude-sonnet-4-6',
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    status: 'done',
    summary: question.slice(0, 200),
    projectId: null,
  });

  return {
    question,
    participants: results.map(r => ({
      personaId: r.personaId,
      personaName: r.personaName,
      reply: r.reply,
      sources: r.sources,
      citationMissingCount: r.citationMissingCount,
      error: r.error,
    })),
    synthesis: synthText,
    synthesisSources: [], // synthesis pulls from participants, not new sources
    totalInputTokens,
    totalOutputTokens,
  };
}

// ---- Ship-readiness audit ----
// Asks every specialist + page agent to audit their domain for ship-blockers
// using a templated prompt. Each returns RED / AMBER / GREEN status,
// blockers, and mitigations. Streams progress back so the UI can light up
// per-agent status as each completes.

export interface AuditAgentReport {
  personaId: string;
  personaName: string;
  status: 'red' | 'amber' | 'green' | 'unknown';
  blockers: string[];
  mitigations: string[];
  sources: { index: number; label: string; score: number }[];
  error?: string;
}

export interface AuditResult {
  ts: number;
  reports: AuditAgentReport[];
  overall: 'red' | 'amber' | 'green';
}

const AUDIT_QUESTION = 'Audit your domain for FXV ship-blockers right now. Output ONLY a JSON object {"status":"red"|"amber"|"green","blockers":[up to 3 short imperative bullets — concrete items that should block ship right now],"mitigations":[up to 3 short bullets — what to do for each blocker]}. RED = should not ship until fixed. AMBER = real risk, document or flag. GREEN = your domain is solid for ship. Use ONLY the sources you can cite. If your domain has no real blockers visible in the sources, status=green and use [] for blockers.';

function parseAuditReply(text: string): { status: AuditAgentReport['status']; blockers: string[]; mitigations: string[] } {
  const fallback = { status: 'unknown' as const, blockers: [] as string[], mitigations: [] as string[] };
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try {
    const parsed = JSON.parse(m[0]);
    const status: AuditAgentReport['status'] =
      parsed.status === 'red' || parsed.status === 'amber' || parsed.status === 'green' ? parsed.status : 'unknown';
    const blockers = Array.isArray(parsed.blockers)
      ? parsed.blockers.filter((x: any) => typeof x === 'string').slice(0, 3).map((s: string) => s.slice(0, 200))
      : [];
    const mitigations = Array.isArray(parsed.mitigations)
      ? parsed.mitigations.filter((x: any) => typeof x === 'string').slice(0, 3).map((s: string) => s.slice(0, 200))
      : [];
    return { status, blockers, mitigations };
  } catch {
    return fallback;
  }
}

export async function runShipAudit(
  onProgress?: (evt: { type: 'start' | 'agent-done'; agentId?: string; report?: AuditAgentReport; total?: number }) => void,
): Promise<AuditResult> {
  const personas = loadPersonas().personas.filter(p => !p.isManager);
  onProgress?.({ type: 'start', total: personas.length });

  const reports = await Promise.all(personas.map(async (p): Promise<AuditAgentReport> => {
    try {
      const r = await consultAdvisor(p.id, AUDIT_QUESTION, []);
      const parsed = parseAuditReply(r.reply);
      const report: AuditAgentReport = {
        personaId: p.id,
        personaName: p.name,
        status: parsed.status,
        blockers: parsed.blockers,
        mitigations: parsed.mitigations,
        sources: r.sources,
      };
      onProgress?.({ type: 'agent-done', agentId: p.id, report });
      return report;
    } catch (err: any) {
      const report: AuditAgentReport = {
        personaId: p.id,
        personaName: p.name,
        status: 'unknown',
        blockers: [],
        mitigations: [],
        sources: [],
        error: err?.message ?? String(err),
      };
      onProgress?.({ type: 'agent-done', agentId: p.id, report });
      return report;
    }
  }));

  const hasRed = reports.some(r => r.status === 'red');
  const hasAmber = reports.some(r => r.status === 'amber');
  const overall: AuditResult['overall'] = hasRed ? 'red' : hasAmber ? 'amber' : 'green';

  return { ts: Date.now(), reports, overall };
}

// Extract concrete action items from an advisor reply. Lightweight Haiku
// pass — no retrieval needed; the reply is the only input. Returns [] when
// the reply is purely informational (no to-dos for Alex).
export async function extractActions(
  question: string,
  reply: string,
  personaName: string,
): Promise<ExtractedAction[]> {
  if (!reply.trim() || reply.length < 60) return [];
  const provider = new AnthropicProvider();
  const systemPrompt = `You extract concrete action items from an FXV advisor reply. The user (Alex, FXV's developer) asked a question; the agent answered. Output ONLY a JSON array of actions Alex should consider doing as a result of this reply. Each action: {"summary": "imperative one-liner under 80 chars", "urgency": "low" | "medium" | "high"}. Output [] if the reply is purely informational, abstract, or doesn't imply action. Do not invent actions the reply doesn't suggest.`;
  const userPrompt = `QUESTION: ${question}\n\nAGENT (${personaName}): ${reply.slice(0, 4000)}\n\nReturn ONLY the JSON array.`;

  let result;
  try {
    result = await provider.run('claude-haiku-4-5-20251001', {
      systemPrompt,
      prompt: userPrompt,
      noTools: true,
      maxTurns: 1,
    }, { _agentId: 'action-extract' } as any);
  } catch (err) {
    return [];
  }

  const match = result.text.trim().match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(x => x && typeof x.summary === 'string' && x.summary.trim().length > 0)
      .map(x => ({
        summary: String(x.summary).slice(0, 200),
        urgency: ['low', 'medium', 'high'].includes(x.urgency) ? x.urgency : 'medium',
      }))
      .slice(0, 6);
  } catch {
    return [];
  }
}
