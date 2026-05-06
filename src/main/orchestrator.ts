import { AgentEvent, AgentSnapshot, DashboardSnapshot, AgentStatus, AgentRole } from '../shared/types';
import { Manager, DispatchRecord } from './manager';
import { Worker } from './worker';
import { Reviewer } from './reviewer';
import { recordDispatch, loadRecentDispatches } from './db';
import { commitWorkerChanges, mergeWorkerBranch, ensureProjectRepo, workerWorktreePath, setActiveProject, activeProjectId } from './projectRepo';
import * as path from 'path';

const WORKER_COUNT = 8;

export class Orchestrator {
  private manager: Manager;
  private workers: Worker[] = [];
  private reviewer: Reviewer;
  // When false, skip the Reviewer pass (e.g. trivial tasks). Default on so the
  // peer-review safety net runs without explicit opt-in.
  private reviewEnabled = true;
  private agents = new Map<string, AgentSnapshot>();
  private currentTask: string | null = null;
  private startedAt = 0;
  private totalTokens = 0;
  private totalCost = 0;
  private paused = false;
  private inFlight = new Map<string, AbortController>(); // workerId -> abort
  private managerBusy = false; // only the decompose phase blocks; never the worker phase
  private busyQueue: { task: string; image?: string; resolve: (r: any) => void }[] = [];
  private dispatchHistory: DispatchRecord[] = []; // memory for Manager status questions
  private rawSubscribers: Array<(evt: AgentEvent) => void> = [];
  // Per-worker bookkeeping for the Reviewer-retry loop and manual override.
  // Cleared on every fresh dispatch (a non-retry execute on that worker).
  private reviewState = new Map<string, {
    originalTask: string;
    model?: string;
    attempts: number;       // Reviewer NEEDS_FIX count (0 = first pass)
    falsePositives: number; // bumped each time the user overrides a NEEDS_FIX
    lastVerdict?: string;   // Reviewer's last NEEDS_FIX message (for UI/override)
  }>();
  private static readonly MAX_REVIEW_RETRIES = 1; // 1 auto-retry → up to 2 reviewer passes
  // Hard cap on tokens consumed per single user-fired run. Default ~5M tokens
  // (~£10 worst case on Sonnet, much less on Haiku). Configurable later.
  private readonly RUN_TOKEN_CAP = 5_000_000;
  private runStartTokens = 0;
  private runCancelled = false;

  constructor(private emit: (evt: AgentEvent) => void) {
    const onEvent = (evt: AgentEvent) => this.handleEvent(evt);

    this.manager = new Manager('M', onEvent);
    this.agents.set('M', this.makeSnapshot('M', 'manager'));

    this.reviewer = new Reviewer('R', onEvent);

    for (let i = 1; i <= WORKER_COUNT; i++) {
      const id = `W${i}`;
      const worker = new Worker(id, onEvent);
      this.workers.push(worker);
      this.agents.set(id, this.makeSnapshot(id, 'coder'));
    }

    this.reloadHistoryForActiveProject();

    // v1.0 Project mode — kick off parent repo init in the background so it's
    // ready before the first worker dispatch. Don't block construction.
    ensureProjectRepo().catch(err => console.warn('[hive] project repo init failed:', err));
  }

  private reloadHistoryForActiveProject(): void {
    try {
      const recent = loadRecentDispatches(20, activeProjectId());
      this.dispatchHistory = recent.map(r => ({
        userInput: r.userInput,
        subtasks: r.subtasks,
        timestamp: r.timestamp,
      }));
    } catch (err) {
      console.warn('[hive] failed to load dispatch history:', err);
      this.dispatchHistory = [];
    }
  }

  // Called by the IPC layer after the active project changes. Refuses while
  // workers are still in-flight so half-dispatched work doesn't leak across
  // projects. Caller is responsible for setActiveProject() + DB update before
  // calling this — orchestrator only owns the in-memory state.
  async onProjectSwitched(): Promise<{ ok: boolean; error?: string }> {
    if (this.inFlight.size > 0) {
      return { ok: false, error: `cancel ${this.inFlight.size} in-flight worker(s) before switching projects` };
    }
    this.reloadHistoryForActiveProject();
    this.reviewState.clear();
    // Reset all worker cards to idle — their old worktrees belonged to the
    // prior project and the next dispatch will recreate from new project's main.
    for (const [id, snap] of this.agents) {
      if (id === 'M') continue;
      snap.status = 'idle';
      snap.task = null;
      snap.log = [];
      snap.startedAt = null;
      this.emit({ type: 'status', id, status: 'idle' });
      this.emit({ type: 'task', id, task: null });
    }
    try { await ensureProjectRepo(); } catch (err) { console.warn('[hive] post-switch repo init:', err); }
    return { ok: true };
  }

  private makeSnapshot(id: string, role: AgentRole): AgentSnapshot {
    return {
      id,
      role,
      status: 'idle',
      task: null,
      log: [],
      worktree: id === 'M' ? null : `wt-${id.slice(1)}`,
      tokens: 0,
      startedAt: null,
    };
  }

  private subscribeRaw(fn: (evt: AgentEvent) => void): () => void {
    this.rawSubscribers.push(fn);
    return () => {
      const i = this.rawSubscribers.indexOf(fn);
      if (i >= 0) this.rawSubscribers.splice(i, 1);
    };
  }

  private handleEvent(evt: AgentEvent) {
    // Fan out to any raw subscribers FIRST so they see all events including
    // ones for unknown agent ids (e.g. the Reviewer 'R' if it ever emits).
    for (const sub of this.rawSubscribers) {
      try { sub(evt); } catch { /* sub failures must not break the orchestrator */ }
    }
    const snap = this.agents.get(evt.id);
    if (!snap) return;

    switch (evt.type) {
      case 'status':
        snap.status = evt.status;
        if (evt.status === 'working' && !snap.startedAt) snap.startedAt = Date.now();
        if (evt.status === 'idle' || evt.status === 'done' || evt.status === 'error') snap.startedAt = null;
        break;
      case 'task':
        snap.task = evt.task;
        break;
      case 'log':
        snap.log.push(evt.line);
        if (snap.log.length > 6) snap.log.shift();
        break;
      case 'tokens':
        snap.tokens += evt.delta;
        this.totalTokens += evt.delta;
        // Hard cost cap: kill all in-flight workers if a run exceeds the cap.
        if (!this.runCancelled && this.totalTokens - this.runStartTokens > this.RUN_TOKEN_CAP) {
          this.runCancelled = true;
          const used = this.totalTokens - this.runStartTokens;
          this.emit({ type: 'log', id: 'M', line: `⛔ token cap hit (${used.toLocaleString()} > ${this.RUN_TOKEN_CAP.toLocaleString()}) — cancelling all workers` });
          this.cancelAll();
        }
        break;
      case 'role':
        snap.role = evt.role;
        break;
    }

    this.emit(evt);
  }

  async runTask(task: string, imageDataUrl?: string): Promise<{ ok: boolean; error?: string }> {
    // If Manager is mid-decompose for an earlier task, queue this one so we
    // never drop the user's input. Workers running in the background do NOT
    // block — only Manager's own thinking is serialised.
    if (this.managerBusy) {
      return new Promise(resolve => {
        this.busyQueue.push({ task, image: imageDataUrl, resolve });
      });
    }
    return this._runOnce(task, imageDataUrl);
  }

  private async _runOnce(task: string, imageDataUrl?: string): Promise<{ ok: boolean; error?: string }> {
    this.currentTask = task;
    this.startedAt = Date.now();
    this.managerBusy = true;
    // Reset run-scope cost tracking.
    this.runStartTokens = this.totalTokens;
    this.runCancelled = false;

    try {
      const result = await this.manager.decompose(task, this.dispatchHistory);
      this.managerBusy = false;

      // Drain queue — any input the user gave while Manager was thinking.
      this.flushBusyQueue();

      if (result === null) {
        // MODE 1 — chat. No dispatch.
        return { ok: true };
      }

      const { subtasks } = result;
      if (subtasks.length === 0) return { ok: true };

      // Record the dispatch so Manager can answer "what have we built" later.
      // Persisted to SQLite so memory survives restart.
      const dispatchPayload = subtasks.map(s => ({ task: s.task, model: s.model }));
      this.dispatchHistory.push({
        userInput: task,
        subtasks: dispatchPayload,
        timestamp: Date.now(),
      });
      if (this.dispatchHistory.length > 20) this.dispatchHistory.shift();
      try { recordDispatch(task, dispatchPayload, activeProjectId()); } catch (err) { console.warn('[hive] dispatch persist failed:', err); }

      // Fan-out is fire-and-forget. Workers run in the background, emitting
      // events as they go. We DO NOT await them here, so runTask returns
      // immediately and the user can chat / dispatch again.
      subtasks.slice(0, this.workers.length).forEach((subtask, i) => {
        const worker = this.workers[i];
        // Skip workers already in-flight from a prior dispatch.
        if (this.inFlight.has(worker.id)) {
          this.emit({ type: 'log', id: worker.id, line: `(busy — skipped new task)` });
          return;
        }
        // Fresh dispatch — reset review bookkeeping for this worker.
        this.reviewState.set(worker.id, {
          originalTask: subtask.task,
          model: subtask.model,
          attempts: 0,
          falsePositives: this.reviewState.get(worker.id)?.falsePositives ?? 0,
        });
        this.dispatchWorker(worker, subtask.task, imageDataUrl, subtask.model);
      });

      return { ok: true };
    } catch (err: any) {
      this.managerBusy = false;
      this.flushBusyQueue();
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  // Single worker dispatch + post-run review/merge. Re-entrant for the
  // Reviewer-redispatch loop: pass continueExisting=true on retry so the
  // worker keeps its branch + prior changes instead of starting fresh.
  private dispatchWorker(
    worker: Worker,
    task: string,
    imageDataUrl: string | undefined,
    model: string | undefined,
    opts: { continueExisting?: boolean } = {},
  ): void {
    const ctrl = new AbortController();
    this.inFlight.set(worker.id, ctrl);

    let workerSucceeded = false;
    let workerSummary = '';
    const captureSummary = (evt: AgentEvent) => {
      if (evt.id === worker.id && evt.type === 'log' && evt.line.startsWith('✓ ')) {
        workerSummary = evt.line.replace(/^✓\s*/, '');
        workerSucceeded = true;
      }
    };
    const unsubscribe = this.subscribeRaw(captureSummary);

    worker.execute(task, imageDataUrl, model, ctrl.signal, opts)
      .catch(err => {
        this.emit({ type: 'log', id: worker.id, line: `✗ ${err?.message ?? err}` });
      })
      .finally(async () => {
        this.inFlight.delete(worker.id);
        unsubscribe();
        if (workerSucceeded && this.reviewEnabled && !this.runCancelled) {
          await this.handleReview(worker, task, workerSummary, imageDataUrl, model);
        }
      });
  }

  private async handleReview(
    worker: Worker,
    task: string,
    workerSummary: string,
    imageDataUrl: string | undefined,
    model: string | undefined,
  ): Promise<void> {
    const worktreePath = workerWorktreePath(worker.id);
    const state = this.reviewState.get(worker.id);

    let verdictPass = false;
    let verdictMsg = '';
    try {
      const verdict = await this.reviewer.review({
        workerId: worker.id,
        worktreePath,
        originalTask: state?.originalTask ?? task,
        workerSummary,
      });
      verdictPass = verdict.pass;
      verdictMsg = verdict.message;
    } catch (err: any) {
      this.emit({ type: 'log', id: worker.id, line: `🔍 review error: ${err?.message ?? err}` });
      // Default to PASS on reviewer failure so a transient Haiku hiccup
      // doesn't strand committed work in limbo.
      verdictPass = true;
    }

    if (verdictPass) {
      await this.commitAndMerge(worker.id, workerSummary, task);
      return;
    }

    // NEEDS_FIX path. Capture verdict so the override IPC has it.
    if (state) {
      state.lastVerdict = verdictMsg;
    }

    const attempts = state?.attempts ?? 0;
    if (attempts < Orchestrator.MAX_REVIEW_RETRIES && !this.runCancelled) {
      if (state) state.attempts = attempts + 1;
      this.emit({ type: 'log', id: worker.id, line: `↻ auto-retry ${attempts + 1}/${Orchestrator.MAX_REVIEW_RETRIES} with reviewer feedback` });
      const retryPrompt = `Your previous attempt at this task was reviewed and rejected.\n\nORIGINAL TASK:\n${state?.originalTask ?? task}\n\nREVIEWER VERDICT (NEEDS_FIX):\n${verdictMsg}\n\nFix the issue described above. Your prior code is still in your worktree — read it, edit it, verify it. Reply with one short summary of what you changed.`;
      // continueExisting:true keeps the branch + files so the worker can
      // iterate rather than start over from main.
      this.dispatchWorker(worker, retryPrompt, imageDataUrl, model, { continueExisting: true });
      return;
    }

    // Out of retries. Leave worker stranded in 'review' status with the
    // verdict captured so the UI override button can force-merge.
    this.emit({ type: 'log', id: worker.id, line: `⏸ stuck on NEEDS_FIX — click "force merge" on the card to override` });
    this.emit({ type: 'status', id: worker.id, status: 'review' });
  }

  private async commitAndMerge(workerId: string, summary: string, fallbackMessage: string): Promise<void> {
    try {
      const committed = await commitWorkerChanges(workerId, summary || fallbackMessage);
      if (!committed) {
        this.emit({ type: 'log', id: workerId, line: '· no file changes to commit' });
        return;
      }
      const merge = await mergeWorkerBranch(workerId, summary || fallbackMessage);
      if (merge.ok) {
        if (merge.alreadyMerged) {
          this.emit({ type: 'log', id: workerId, line: '🌿 nothing to merge' });
        } else {
          this.emit({ type: 'log', id: workerId, line: '🌿 merged into main' });
        }
      } else {
        const files = merge.conflict?.length ? ` (${merge.conflict.slice(0, 3).join(', ')})` : '';
        this.emit({ type: 'log', id: workerId, line: `⚠ merge conflict${files} — branch left for manual resolution` });
        this.emit({ type: 'status', id: workerId, status: 'review' });
      }
    } catch (err: any) {
      this.emit({ type: 'log', id: workerId, line: `✗ commit/merge: ${err?.message ?? err}` });
    }
  }

  // User-triggered force-merge from the dashboard. Bumps the worker's
  // false-positive count for diagnostics.
  async overrideReview(workerId: string): Promise<{ ok: boolean; error?: string; falsePositives?: number }> {
    const state = this.reviewState.get(workerId);
    const snap = this.agents.get(workerId);
    if (!snap) return { ok: false, error: 'unknown worker' };
    if (snap.status !== 'review') return { ok: false, error: 'worker is not in review state' };
    if (state) state.falsePositives += 1;
    const verdict = state?.lastVerdict ? ` (was: ${state.lastVerdict.slice(0, 80)})` : '';
    this.emit({ type: 'log', id: workerId, line: `🟢 reviewer overridden by user${verdict}` });
    const message = state?.originalTask ?? snap.task ?? 'override merge';
    await this.commitAndMerge(workerId, message, message);
    if (snap.status === 'review') this.emit({ type: 'status', id: workerId, status: 'done' });
    return { ok: true, falsePositives: state?.falsePositives ?? 0 };
  }

  reviewerStats(workerId: string): { falsePositives: number; lastVerdict?: string } {
    const s = this.reviewState.get(workerId);
    return { falsePositives: s?.falsePositives ?? 0, lastVerdict: s?.lastVerdict };
  }

  private flushBusyQueue() {
    const next = this.busyQueue.shift();
    if (!next) return;
    // Fire-and-forget the queued task; resolve its promise when it returns.
    this._runOnce(next.task, next.image).then(next.resolve);
  }

  // Spec Interview entrypoint — bypasses the dispatch flow. Returns 0-4
  // clarification questions the renderer renders inline; the user fills them
  // in then fires runTask with the enriched prompt.
  async runSpecInterview(task: string): Promise<string[]> {
    if (this.managerBusy) return []; // busy → skip rather than queue
    this.managerBusy = true;
    try {
      return await this.manager.interview(task);
    } finally {
      this.managerBusy = false;
      this.flushBusyQueue();
    }
  }

  inFlightCount(): number { return this.inFlight.size; }

  cancelWorker(id: string): boolean {
    const ctrl = this.inFlight.get(id);
    if (!ctrl) return false;
    ctrl.abort();
    this.emit({ type: 'log', id, line: '⏹ cancelled by user' });
    this.emit({ type: 'status', id, status: 'idle' });
    this.inFlight.delete(id);
    return true;
  }

  cancelAll(): number {
    let n = 0;
    for (const id of Array.from(this.inFlight.keys())) {
      if (this.cancelWorker(id)) n++;
    }
    return n;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  snapshot(): DashboardSnapshot {
    return {
      task: this.currentTask,
      agents: Array.from(this.agents.values()),
      totalCost: this.totalCost,
      totalTokens: this.totalTokens,
      runtimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  shutdown() {
    // v0.1: nothing to clean up. v0.2 will dispose worktrees + SDK sessions.
  }
}
