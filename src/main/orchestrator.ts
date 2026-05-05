import { AgentEvent, AgentSnapshot, DashboardSnapshot, AgentStatus, AgentRole } from '../shared/types';
import { Manager, DispatchRecord } from './manager';
import { Worker } from './worker';
import { Reviewer } from './reviewer';
import { recordDispatch, loadRecentDispatches } from './db';
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

    // Restore Manager's chat memory from disk so "what have we built?" survives restart.
    try {
      const recent = loadRecentDispatches(20);
      this.dispatchHistory = recent.map(r => ({
        userInput: r.userInput,
        subtasks: r.subtasks,
        timestamp: r.timestamp,
      }));
    } catch (err) {
      console.warn('[hive] failed to load dispatch history:', err);
    }
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
      try { recordDispatch(task, dispatchPayload); } catch (err) { console.warn('[hive] dispatch persist failed:', err); }

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
        const ctrl = new AbortController();
        this.inFlight.set(worker.id, ctrl);

        let workerSucceeded = false;
        let workerSummary = '';
        const captureSummary = (evt: AgentEvent) => {
          // Worker.execute logs `✓ <summary>` on success — capture it for the
          // Reviewer prompt. Last such line wins.
          if (evt.id === worker.id && evt.type === 'log' && evt.line.startsWith('✓ ')) {
            workerSummary = evt.line.replace(/^✓\s*/, '');
            workerSucceeded = true;
          }
        };
        // Hook the orchestrator's own emit briefly. Cheaper than threading a
        // result back through Worker.execute.
        const wrappedHandler = (evt: AgentEvent) => { captureSummary(evt); };
        const unsubscribe = this.subscribeRaw(wrappedHandler);

        worker.execute(subtask.task, imageDataUrl, subtask.model, ctrl.signal)
          .catch(err => {
            this.emit({ type: 'log', id: worker.id, line: `✗ ${err?.message ?? err}` });
          })
          .finally(async () => {
            this.inFlight.delete(worker.id);
            unsubscribe();
            if (workerSucceeded && this.reviewEnabled && !this.runCancelled) {
              try {
                const worktreePath = path.join(process.cwd(), 'worktrees', `wt-${worker.id.slice(1)}`);
                await this.reviewer.review({
                  workerId: worker.id,
                  worktreePath,
                  originalTask: subtask.task,
                  workerSummary,
                });
              } catch (err: any) {
                this.emit({ type: 'log', id: worker.id, line: `🔍 review error: ${err?.message ?? err}` });
              }
            }
          });
      });

      return { ok: true };
    } catch (err: any) {
      this.managerBusy = false;
      this.flushBusyQueue();
      return { ok: false, error: err?.message ?? String(err) };
    }
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
