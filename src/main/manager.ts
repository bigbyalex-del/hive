import { AgentEvent } from '../shared/types';
import { getProvider } from './providers/registry';
import { getAgentConfig } from './config';

const SYSTEM = `You are the Manager of HIVE, a multi-agent app-building system. You never edit code. Your job: route user input AND pick the right AI model for each subtask.

Two response modes — pick exactly ONE:

MODE 1 — CHAT (conversational ONLY — NOT for any actionable request)
Use ONLY for: pure greetings ("hi", "hello"), gratitude ("thanks"), or questions about state/progress ("what have you built?", "how's it going?").
If RECENT WORK HISTORY is provided, use it to answer status questions truthfully.
Reply: \`CHAT: <short friendly answer, under 120 chars>\`

CRITICAL: Even if the user addresses you directly ("can you list X", "use Y tool to do Z", "show me the files"), this is STILL a task to DISPATCH to a worker — not chat. Never ask permission ("want me to dispatch?"). Just dispatch. The user knows you orchestrate workers; rephrasing the request to a worker is your job.

MODE 2 — DISPATCH (one or more workers — always JSON)
For real engineering tasks (build, fix, write, create, design, refactor).
Reply: a JSON array on a single line. Each item is an object with "task" and "model".
  [{"task":"<under 200 chars>","model":"haiku"|"sonnet"|"opus"}, ...]

Use 1 item for a single focused task. Use 2-8 items ONLY when the work is truly independent (no shared files, runnable without seeing each other's output). Max 8 items.

Model menu — pick the CHEAPEST model that can plausibly do the job:

- "haiku" — fastest, cheapest. Use for: simple file creation, find-and-replace, boilerplate HTML/CSS, copy-paste-edit, repetitive pattern work, anything a junior dev could do in 5 minutes. This should be your DEFAULT for most subtasks.
- "sonnet" — balanced. Use for: implementing real features, writing components with logic, non-trivial JS/TS, anything requiring multi-step reasoning across files.
- "opus" — slowest, dearest. Use ONLY for: architectural decisions, ambiguous problems requiring deep reasoning, complex refactors touching many files, hard debugging, security-sensitive code. Default to NOT using opus.

Examples:
- "create hello.html with hi" → [{"task":"create hello.html with body 'hi'","model":"haiku"}]
- "build 4 landing pages: tech startup, fitness, ecommerce, blog, plus shared footer" → [{"task":"...","model":"haiku"},{"task":"...","model":"haiku"},{"task":"...","model":"haiku"},{"task":"...","model":"haiku"},{"task":"...","model":"haiku"}]
- "implement OAuth login with Google" → [{"task":"...","model":"sonnet"}]
- "redesign our auth architecture for SSO support" → [{"task":"...","model":"opus"}]

Rules:
- Never split sequential work into parallel (e.g. "build then test" — sequential, ONE item).
- Never split work that touches the same file.
- For pattern work (multiple similar pages, multiple similar fixes), fan out with haiku per item.
- If the user's input begins with a tag like \`[project: iOS app — ...]\` or \`[redline annotation on ios preview — target W3]\`, treat its constraints as binding and **propagate them inside every subtask's "task" string** (so workers see the form-factor + viewport hints even after rephrase). When a tag pins a specific worker (e.g. \`target W3\`), emit a single dispatch — the orchestrator routes by index, so put the targeted task first and only.
- Reply with ONLY the chosen mode's output. No explanation.`;

export interface DispatchRecord {
  userInput: string;
  subtasks: { task: string; model?: string }[];
  timestamp: number;
}

export class Manager {
  constructor(public id: string, private emit: (evt: AgentEvent) => void) {}

  async decompose(task: string, history: DispatchRecord[] = []): Promise<{ subtasks: { task: string; model?: string }[] } | null> {
    this.emit({ type: 'status', id: this.id, status: 'working' });
    this.emit({ type: 'task', id: this.id, task });
    this.emit({ type: 'log', id: this.id, line: '→ decomposing user task' });

    const cfg = getAgentConfig(this.id);
    const provider = getProvider(cfg.provider);
    this.emit({ type: 'log', id: this.id, line: `· ${cfg.provider}/${cfg.model}` });

    try {
      const events: any = {
        onError: (err: Error) => this.emit({ type: 'log', id: this.id, line: `✗ ${err.message}` }),
        _tokenDelta: (delta: number) => this.emit({ type: 'tokens', id: this.id, delta }),
      };

      // Stitch recent dispatch history into the prompt so Manager can answer
      // status questions ("how's the site looking?") with real context instead
      // of replying "haven't built anything yet."
      let prompt = task;
      if (history.length > 0) {
        const recent = history.slice(-10).map((h, i) => {
          const subs = h.subtasks.map(s => `    - ${s.task} [${s.model ?? 'default'}]`).join('\n');
          return `[${i + 1}] User said: "${h.userInput}"\n  Dispatched:\n${subs}`;
        }).join('\n');
        prompt = `## RECENT WORK HISTORY (your earlier dispatches in this session)\n${recent}\n\n## CURRENT USER INPUT\n${task}`;
      }

      const result = await provider.run(cfg.model, {
        systemPrompt: SYSTEM,
        prompt,
        maxTurns: 1,
        noTools: true, // Manager is pure routing — never call MCP/file tools
      }, events);

      const raw = result.text.trim();

      // Manager returned nothing — model hit max_tokens before generating
      // text, or the tool loop dead-ended. Bail rather than dispatching empty.
      if (!raw) {
        this.emit({ type: 'log', id: this.id, line: '⚠ Manager returned empty response — try rephrasing' });
        this.emit({ type: 'status', id: this.id, status: 'error' });
        return null;
      }

      // MODE 1 — Manager handled it itself, no dispatch.
      if (raw.toUpperCase().startsWith('CHAT:')) {
        const reply = raw.replace(/^CHAT:\s*/i, '');
        this.emit({ type: 'log', id: this.id, line: `💬 ${reply}` });
        this.emit({ type: 'status', id: this.id, status: 'done' });
        return null;
      }

      // MODE 2 — JSON array of {task, model} dispatch objects.
      const trimmed = raw.startsWith('```') ? raw.replace(/^```(?:json)?|```$/g, '').trim() : raw;
      if (trimmed.startsWith('[')) {
        try {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr) && arr.length > 0) {
            const subtasks: { task: string; model?: string }[] = arr.slice(0, 8)
              .map((item: any) => {
                if (typeof item === 'string') return { task: item.trim() };
                if (item && typeof item.task === 'string') {
                  return { task: item.task.trim(), model: typeof item.model === 'string' ? item.model.toLowerCase() : undefined };
                }
                return null;
              })
              .filter((x: any): x is { task: string; model?: string } => !!x && !!x.task);

            if (subtasks.length > 0) {
              this.emit({ type: 'log', id: this.id, line: `→ ${subtasks.length} subtask${subtasks.length > 1 ? 's' : ''}` });
              subtasks.forEach((st, i) => {
                const tag = st.model ? `[${st.model}]` : '';
                this.emit({ type: 'log', id: this.id, line: `   W${i + 1} ${tag} ${st.task.slice(0, 60)}` });
              });
              this.emit({ type: 'status', id: this.id, status: 'done' });
              return { subtasks };
            }
          }
        } catch { /* fall through */ }
      }

      // Fallback — model didn't return JSON, treat the raw string as a single subtask.
      const cleaned = trimmed.replace(/^["']|["']$/g, '').trim();
      this.emit({ type: 'log', id: this.id, line: `→ subtask: ${cleaned.slice(0, 80)}` });
      this.emit({ type: 'log', id: this.id, line: '→ dispatching to W1' });
      this.emit({ type: 'status', id: this.id, status: 'done' });
      return { subtasks: [{ task: cleaned }] };
    } catch (err: any) {
      this.emit({ type: 'log', id: this.id, line: `✗ ${err?.message ?? err}` });
      this.emit({ type: 'status', id: this.id, status: 'error' });
      throw err;
    }
  }

  // Spec Interview — given a raw task, return 2-4 sharp clarification questions
  // the user must answer before dispatch. Reduces off-piste output by forcing
  // the user to commit to acceptance criteria up front.
  async interview(task: string): Promise<string[]> {
    this.emit({ type: 'status', id: this.id, status: 'working' });
    this.emit({ type: 'log', id: this.id, line: '📋 spec interview…' });

    const cfg = getAgentConfig(this.id);
    const provider = getProvider(cfg.provider);

    const INTERVIEW_SYSTEM = `You are the Spec Interviewer in HIVE. The user wants to build something. Your job: output 2-4 SHARP questions whose answers would prevent the most likely off-piste output. Focus on:
- Scope / "done means what" (one screen vs many, with auth vs no, real data vs mocked)
- Visual style or framework choice IF it isn't implied
- Inputs / data shape / target platform
- Edge cases the user has clearly forgotten

Skip questions whose answers are obvious from context. Skip nice-to-have polish questions. The questions must be answerable in one short sentence each.

Reply with ONLY a JSON array of strings. No preamble, no markdown, no trailing text. Example: ["What framework — vanilla HTML or React?","Is this a single page or multiple?","Should it persist data, and where?"]

If the task is already specified clearly enough that no questions are needed, return an empty array \`[]\` and the dispatcher will skip the interview.`;

    try {
      const result = await provider.run(cfg.model, {
        systemPrompt: INTERVIEW_SYSTEM,
        prompt: task,
        maxTurns: 1,
        noTools: true,
      } as any, {
        onError: (err: Error) => this.emit({ type: 'log', id: this.id, line: `✗ ${err.message}` }),
        _tokenDelta: (delta: number) => this.emit({ type: 'tokens', id: this.id, delta }),
      } as any);

      const raw = result.text.trim();
      this.emit({ type: 'status', id: this.id, status: 'done' });

      const cleaned = raw.startsWith('```') ? raw.replace(/^```(?:json)?|```$/g, '').trim() : raw;
      try {
        const arr = JSON.parse(cleaned);
        if (Array.isArray(arr)) {
          const questions = arr.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, 4);
          this.emit({ type: 'log', id: this.id, line: `📋 ${questions.length} question${questions.length === 1 ? '' : 's'}` });
          return questions;
        }
      } catch { /* fall through */ }
      this.emit({ type: 'log', id: this.id, line: '⚠ interview returned non-JSON, skipping spec' });
      return [];
    } catch (err: any) {
      this.emit({ type: 'log', id: this.id, line: `✗ interview: ${err?.message ?? err}` });
      this.emit({ type: 'status', id: this.id, status: 'error' });
      return [];
    }
  }
}
