import { app, BrowserWindow, ipcMain, globalShortcut, nativeImage, dialog } from 'electron';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Orchestrator } from './orchestrator';
import { IPC, AgentEvent } from '../shared/types';
import { getModelConfig, setModelConfig } from './config';
import { listProviders } from './providers/registry';
import { transcribeAudio } from './voice';
import { captureScreen, snipRegion } from './screenshot';
import { speak } from './tts';
import { loadDefaultMcpServers, shutdownAllMcp } from './mcp';
import { initDb, shutdownDb } from './db';
import { listTemplates, scaffoldTemplate } from './templates';
import { projectDir, commitProjectChanges, ensureProjectRepo, workerWorktreePath, setActiveProject } from './projectRepo';
import { listProjects, createProject, getProject, getActiveProjectId, setActiveProjectId, deleteProject, aggregateRuns } from './db';
import { costGBP } from './pricing';
import { diffWorkerBranch } from './projectRepo';
import { babysitStart, babysitStop, babysitStatus } from './babysit';
import { listAdvisors, consultAdvisor, extractActions, runCouncil, runShipAudit, expandMindTopic, auditActions } from './advisors';
import { runSeed } from '../scripts/seed-fxv-personas';
import { startAlertsPolling, stopAlertsPolling, pollAllOnce, alertsConfig } from './alerts';
import { listAlerts as dbListAlerts, setAlertStatus, deleteAlertRow, reconcileStuckDeploys } from './db';
import { extractIntent as deployExtractIntent, preparePlan as deployPreparePlan, executePlan as deployExecutePlan, rollback as deployRollback, deployHistory } from './deploy';
import { getPulse as pulseGet, markPulseSeen as pulseMarkSeen } from './pulse';
import { listChatsForPersona, previewByPersona } from './db';
import { insertAction, listActions as dbListActions, getAction as dbGetAction, updateAction as dbUpdateAction, deleteAction as dbDeleteAction } from './db';
import { listCanvases as dbListCanvases, getCanvas as dbGetCanvas, createCanvas as dbCreateCanvas, saveCanvasState, deleteCanvas as dbDeleteCanvas } from './db';
import { listDrafts as draftsList, openDraftFolderInExplorer, openHeroInPlayer } from './drafts';
import { generateNextDraft as pipelineGenerate, getQueueSummary as pipelineGetQueue } from './contentPipeline';
import { start as flowStart, stop as flowStop, snapshot as flowSnapshot, attachWindow as flowAttachWindow, isRunning as flowIsRunning } from './flowMode';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

let mainWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;
let orchestrator: Orchestrator | null = null;

let previewReady = false;
let pendingPreviewHtml: string | null = null;
let pendingPreviewType: string | null = null;
let lastPreviewType = 'web';

function openPreviewWindow() {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.focus();
    return;
  }
  previewReady = false;
  // Reset dedupe so the first push after open isn't blocked as duplicate.
  lastBroadcastHtml = '';
  // iOS bezel needs vertical space — open taller. Web mode is fine wider.
  const tallForIos = lastPreviewType === 'ios';
  previewWindow = new BrowserWindow({
    width: tallForIos ? 520 : 1280,
    height: tallForIos ? 1040 : 800,
    title: 'Hive — Preview',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  previewWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'preview.html'));
  previewWindow.webContents.on('did-finish-load', () => {
    previewReady = true;
    if (pendingPreviewType !== null) {
      injectPreviewType(pendingPreviewType);
      pendingPreviewType = null;
    } else {
      injectPreviewType(lastPreviewType);
    }
    if (pendingPreviewHtml !== null) {
      injectPreview(pendingPreviewHtml);
      pendingPreviewHtml = null;
    }
  });
  previewWindow.on('closed', () => {
    previewWindow = null;
    previewReady = false;
  });
}

function injectPreview(html: string) {
  if (!previewWindow || previewWindow.isDestroyed()) return;
  const safe = JSON.stringify(html);
  // Iframe pre-exists in preview.html — just update srcdoc.
  previewWindow.webContents.executeJavaScript(`
    (function() {
      const f = document.getElementById('f');
      if (f) {
        f.srcdoc = ${safe};
        document.body.classList.add('loaded');
      }
      true;
    })();
  `).catch(err => console.error('[hive] preview injection failed:', err));
}

function injectPreviewUrl(url: string) {
  if (!previewWindow || previewWindow.isDestroyed()) return;
  const safe = JSON.stringify(url);
  previewWindow.webContents.executeJavaScript(`
    (function() {
      const f = document.getElementById('f');
      if (f) {
        f.removeAttribute('srcdoc');
        f.src = ${safe};
        document.body.classList.add('loaded');
      }
      true;
    })();
  `).catch(err => console.error('[hive] preview url injection failed:', err));
}

function injectPreviewType(projectType: string) {
  if (!previewWindow || previewWindow.isDestroyed()) return;
  // Resize to phone dimensions when switching to ios so the bezel doesn't sit
  // in a sea of dead space.
  if (projectType === 'ios') {
    try { previewWindow.setSize(520, 1040); } catch {}
  }
  const safeType = JSON.stringify(projectType);
  previewWindow.webContents.executeJavaScript(`
    (function() {
      document.body.classList.remove('ptype-web', 'ptype-ios', 'ptype-api');
      document.body.classList.add('ptype-' + ${safeType});
      true;
    })();
  `).catch(err => console.error('[hive] preview type injection failed:', err));
}

let lastBroadcastHtml = '';
function broadcastPreview(html: string, projectType?: string) {
  if (projectType) lastPreviewType = projectType;
  if (!previewWindow || previewWindow.isDestroyed()) {
    // No window open — don't update dedupe key so next push (after open) lands.
    return;
  }
  if (!previewReady) {
    pendingPreviewHtml = html;
    if (projectType) pendingPreviewType = projectType;
    return;
  }
  if (projectType) injectPreviewType(projectType);
  if (html === lastBroadcastHtml) return; // skip duplicate to avoid iframe reload flash
  lastBroadcastHtml = html;
  injectPreview(html);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0b0f14',
    title: 'Hive — YourAIHive',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));
  flowAttachWindow(mainWindow);

  if (process.env.HIVE_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[hive] ANTHROPIC_API_KEY missing — copy .env.example to .env and fill it in.');
  }

  // Bring up the persistent state store before the orchestrator inits, so it
  // can restore Manager's dispatch history from disk.
  try { await initDb(); } catch (err) { console.error('[hive] db init failed:', err); }

  // Resolve the active project from the meta table and prime projectRepo so
  // every workerWorktreePath() / projectDir() call lands on the right place.
  try {
    const activeId = getActiveProjectId() ?? 1;
    const proj = getProject(activeId) ?? getProject(1);
    if (proj) setActiveProject({ id: proj.id, dir: proj.dir });
  } catch (err) {
    console.warn('[hive] active project lookup failed, defaulting:', err);
  }

  createWindow();

  // Kick off MCP server connections in the background — workers see new tools
  // when servers come online (typically within a few seconds).
  loadDefaultMcpServers().catch(err => console.error('[hive] MCP init failed:', err));

  orchestrator = new Orchestrator((evt: AgentEvent) => {
    mainWindow?.webContents.send(IPC.AgentEvent, evt);
    // Auto-speak Manager chat replies via TTS.
    if (evt.type === 'log' && evt.id === 'M' && evt.line.startsWith('💬')) {
      const text = evt.line.replace(/^💬\s*/, '');
      mainWindow?.webContents.send(IPC.ManagerSpoke, text);
    }
  });

  ipcMain.handle(IPC.RunTask, async (_e, payload: string | { task: string; imageDataUrl?: string }) => {
    if (!orchestrator) return { ok: false, error: 'no orchestrator' };
    if (typeof payload === 'string') return orchestrator.runTask(payload);
    return orchestrator.runTask(payload.task, payload.imageDataUrl);
  });

  ipcMain.handle(IPC.Snapshot, () => orchestrator?.snapshot() ?? null);
  ipcMain.handle(IPC.Pause, () => orchestrator?.pause());
  ipcMain.handle(IPC.Resume, () => orchestrator?.resume());
  ipcMain.handle(IPC.CancelWorker, (_e, id: string) => orchestrator?.cancelWorker(id) ?? false);
  ipcMain.handle(IPC.CancelAll, () => orchestrator?.cancelAll() ?? 0);
  ipcMain.handle(IPC.ListWorktreeFiles, async (_e, workerId: string) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    // v1.0 — accept 'project' to peek at the merged main branch; W1..W8 still
    // route to per-worker branches for live preview of in-flight work.
    const dir = workerId === 'project' ? projectDir() : workerWorktreePath(workerId);
    try {
      const out: { path: string; mtime: number; size: number }[] = [];
      async function walk(d: string, rel = '') {
        const entries = await fs.readdir(d, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue;
          const full = path.join(d, e.name);
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(full, r);
          else {
            const st = await fs.stat(full);
            out.push({ path: r, mtime: st.mtimeMs, size: st.size });
          }
        }
      }
      await walk(dir);
      out.sort((a, b) => b.mtime - a.mtime);
      return { ok: true, dir, files: out };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.ReadWorktreeFile, async (_e, payload: { workerId: string; path: string }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const dir = payload.workerId === 'project' ? projectDir() : workerWorktreePath(payload.workerId);
    const abs = path.resolve(dir, payload.path);
    if (!abs.startsWith(path.resolve(dir))) return { ok: false, error: 'path outside worktree' };
    try {
      const content = await fs.readFile(abs, 'utf8');
      return { ok: true, content };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.GetModelConfig, () => getModelConfig());
  ipcMain.handle(IPC.SetModelConfig, (_e, cfg) => { setModelConfig(cfg); return { ok: true }; });
  ipcMain.handle(IPC.ListProviders, () => listProviders());
  ipcMain.handle(IPC.OpenPreviewWindow, () => { openPreviewWindow(); return { ok: true }; });
  ipcMain.handle(IPC.PreviewLoadUrl, (_e, payload: { url: string; projectType?: string }) => {
    if (!previewWindow || previewWindow.isDestroyed()) openPreviewWindow();
    const ptype = payload.projectType ?? 'ios';
    lastPreviewType = ptype;
    if (!previewReady) {
      pendingPreviewType = ptype;
      // Queue url via srcdoc-less inject once ready.
      previewWindow?.webContents.once('did-finish-load', () => {
        injectPreviewType(ptype);
        injectPreviewUrl(payload.url);
      });
    } else {
      injectPreviewType(ptype);
      injectPreviewUrl(payload.url);
    }
    return { ok: true };
  });
  ipcMain.handle(IPC.CodebaseSnapshotStats, async () => {
    const { getSnapshot, getSnapshotStats } = await import('./codebaseSnapshot');
    let stats = getSnapshotStats();
    if (!stats) {
      await getSnapshot();
      stats = getSnapshotStats();
    }
    return { ok: true, stats };
  });
  ipcMain.handle(IPC.CodebaseSnapshotRefresh, async () => {
    const mod = await import('./codebaseSnapshot');
    mod.invalidateSnapshot();
    await mod.getSnapshot();
    return { ok: true, stats: mod.getSnapshotStats() };
  });
  ipcMain.handle(IPC.AuditActions, async () => {
    try {
      const projectId = getActiveProjectId() ?? undefined;
      const all = dbListActions({ projectId, limit: 500 });
      const live = all.filter(a => a.status !== 'done');
      if (!live.length) return { ok: true, items: [] };
      const audit = await auditActions(live as any);
      return { ok: true, items: audit };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.CaptureBug, async (_e, payload: { note?: string }) => {
    if (!previewWindow || previewWindow.isDestroyed()) {
      return { ok: false, error: 'preview window not open — start Flow first' };
    }
    try {
      const fsp = await import('fs/promises');
      const image = await previewWindow.webContents.capturePage();
      const buf = image.toPNG();
      const ts = Date.now();
      const stamp = new Date(ts).toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
      const dir = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.hive', 'bug-reports');
      await fsp.mkdir(dir, { recursive: true });
      const pngPath = path.join(dir, `${stamp}.png`);
      await fsp.writeFile(pngPath, buf);
      // Pull iframe URL so we know what route was on screen.
      let iframeUrl: string | null = null;
      try {
        iframeUrl = await previewWindow.webContents.executeJavaScript(
          "(function(){var f=document.getElementById('f');return f?(f.src||f.contentWindow?.location?.href||null):null;})()",
        );
      } catch {}
      const noteText = (payload?.note || '').trim();
      const content = `Bug @ ${new Date(ts).toLocaleString()}${noteText ? ` — ${noteText}` : ''}`;
      const source =
        `Screenshot: ${pngPath}\n` +
        (iframeUrl ? `URL: ${iframeUrl}\n` : '') +
        `Captured: ${new Date(ts).toISOString()}\n` +
        (noteText ? `\nNote: ${noteText}\n` : '');
      const id = insertAction({
        content,
        status: 'todo',
        priority: 'medium',
        sourceQuestion: source,
        projectId: getActiveProjectId() ?? null,
      });
      return { ok: true, actionId: id, pngPath, iframeUrl };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.FlowStart, async () => {
    const result = await flowStart();
    if (result.ok && result.url) {
      // Auto-open preview window in iOS bezel pointing at the dev server.
      // Set type BEFORE opening so the window opens at iPhone dimensions, not desktop.
      lastPreviewType = 'ios';
      if (!previewWindow || previewWindow.isDestroyed()) openPreviewWindow();
      if (previewReady) {
        injectPreviewType('ios');
        injectPreviewUrl(result.url);
      } else {
        pendingPreviewType = 'ios';
        previewWindow?.webContents.once('did-finish-load', () => {
          injectPreviewType('ios');
          injectPreviewUrl(result.url!);
        });
      }
    }
    return result;
  });
  ipcMain.handle(IPC.FlowStop, async () => flowStop());
  ipcMain.handle(IPC.FlowStatus, () => flowSnapshot());
  ipcMain.handle(IPC.PreviewBroadcast, (_e, payload: string | { html: string; projectType?: string }) => {
    if (typeof payload === 'string') broadcastPreview(payload);
    else broadcastPreview(payload.html, payload.projectType);
    return { ok: true };
  });
  ipcMain.handle(IPC.TranscribeAudio, async (_e, payload: { bytes: ArrayBuffer; mime: string }) => {
    try {
      const text = await transcribeAudio(new Uint8Array(payload.bytes), payload.mime);
      return { ok: true, text };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.CaptureScreen, async () => {
    try {
      const result = await captureScreen();
      return { ok: true, ...result };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.SnipRegion, async () => {
    try {
      const result = await snipRegion();
      return { ok: true, ...result };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  // Global hotkey — Ctrl+Shift+H triggers snip from anywhere on Windows,
  // even when Hive isn't focused. The window is brought to the front when
  // the snip lands so the user sees the thumbnail attached.
  const hotkeyOk = globalShortcut.register('CommandOrControl+Shift+H', async () => {
    try {
      const result = await snipRegion();
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send(IPC.SnipResult, { ok: true, ...result });
    } catch (err: any) {
      mainWindow?.webContents.send(IPC.SnipResult, { ok: false, error: err?.message ?? String(err) });
    }
  });
  if (!hotkeyOk) console.warn('[hive] failed to register Ctrl+Shift+H global hotkey');
  ipcMain.handle(IPC.OverrideReview, async (_e, workerId: string) => {
    if (!orchestrator) return { ok: false, error: 'no orchestrator' };
    return orchestrator.overrideReview(workerId);
  });

  ipcMain.handle(IPC.ListProjects, () => {
    const all = listProjects();
    const activeId = getActiveProjectId();
    return { ok: true, projects: all, activeId };
  });
  ipcMain.handle(IPC.GetActiveProject, () => {
    const activeId = getActiveProjectId();
    if (activeId == null) return { ok: false };
    const proj = getProject(activeId);
    return { ok: !!proj, project: proj ?? null };
  });
  ipcMain.handle(IPC.CreateProject, async (_e, payload: string | { name: string; gitUrl?: string }) => {
    const isObj = typeof payload === 'object' && payload !== null;
    const name = isObj ? payload.name : payload;
    const gitUrl = isObj ? (payload.gitUrl || '').trim() : '';
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return { ok: false, error: 'name required' };
    if (trimmed.length > 60) return { ok: false, error: 'name too long (max 60 chars)' };
    const baseSlug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    const existing = new Set(listProjects().map(p => p.slug));
    let slug = baseSlug;
    let i = 2;
    while (existing.has(slug)) { slug = `${baseSlug}-${i++}`; }
    const dir = `worktrees/projects/${slug}`;
    const absDir = path.join(process.cwd(), dir);
    try {
      const fs = await import('fs/promises');
      if (gitUrl) {
        // Clone path — assumes auth via SSH or PAT-in-URL. We do NOT inject
        // env tokens here; the user's git config handles credentials.
        await fs.mkdir(path.dirname(absDir), { recursive: true });
        const { spawn } = await import('child_process');
        await new Promise<void>((resolve, reject) => {
          const child = spawn('git', ['clone', gitUrl, absDir], { shell: false, windowsHide: true });
          let stderr = '';
          child.stderr.on('data', b => { stderr += b.toString(); });
          child.on('error', reject);
          child.on('close', code => code === 0 ? resolve() : reject(new Error(`git clone failed: ${stderr.slice(0, 200)}`)));
        });
      } else {
        await fs.mkdir(absDir, { recursive: true });
      }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
    const proj = createProject(trimmed, slug, dir);
    if (!proj) return { ok: false, error: 'db insert failed' };
    return { ok: true, project: proj };
  });
  ipcMain.handle(IPC.SwitchProject, async (_e, id: number) => {
    const proj = getProject(id);
    if (!proj) return { ok: false, error: 'project not found' };
    // Block flip if workers are still busy — switching mid-flight would
    // leave the next merge pointing at the wrong repo.
    if (orchestrator && orchestrator.inFlightCount() > 0) {
      return { ok: false, error: `cancel ${orchestrator.inFlightCount()} in-flight worker(s) before switching projects` };
    }
    setActiveProject({ id: proj.id, dir: proj.dir });
    setActiveProjectId(proj.id);
    const res = orchestrator ? await orchestrator.onProjectSwitched() : { ok: true };
    return { ...res, project: proj };
  });
  ipcMain.handle(IPC.GetCostSummary, async (_e, projectId: number | null) => {
    // Returns spend totals: today (since local midnight), project-active,
    // all-time. Numbers come from runs aggregated by model × pricing.ts rates.
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const allTime = aggregateRuns({});
    const today = aggregateRuns({ sinceTs: startOfDay.getTime() });
    const project = aggregateRuns({ projectId: projectId ?? getActiveProjectId() ?? 1 });
    const sumGBP = (rows: { model: string; inputTokens: number; outputTokens: number }[]) =>
      rows.reduce((s, r) => s + costGBP(r.model, r.inputTokens, r.outputTokens), 0);
    const sumTokens = (rows: { inputTokens: number; outputTokens: number }[]) =>
      rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
    return {
      ok: true,
      today: { gbp: sumGBP(today), tokens: sumTokens(today), runs: today.reduce((s, r) => s + (r as any).runs, 0) },
      project: { gbp: sumGBP(project), tokens: sumTokens(project) },
      allTime: { gbp: sumGBP(allTime), tokens: sumTokens(allTime) },
      byModel: allTime.map(r => ({ model: r.model, runs: r.runs, tokens: r.inputTokens + r.outputTokens, gbp: costGBP(r.model, r.inputTokens, r.outputTokens) })),
    };
  });
  ipcMain.handle(IPC.BabysitStart, async (_e, payload: { repo: string; label: string; intervalMs: number; tokenEnv: string }) => {
    if (!orchestrator) return { ok: false, error: 'no orchestrator' };
    const log = (line: string) => mainWindow?.webContents.send(IPC.BabysitLog, line);
    const stateChanged = () => mainWindow?.webContents.send(IPC.BabysitLog, '__state__');
    return babysitStart(orchestrator, {
      repo: payload.repo,
      label: payload.label || 'hive-take-this',
      intervalMs: Math.max(30_000, Number(payload.intervalMs) || 60_000),
      tokenEnv: payload.tokenEnv || 'GITHUB_TOKEN',
    }, log, stateChanged);
  });
  ipcMain.handle(IPC.BabysitStop, () => babysitStop());
  ipcMain.handle(IPC.BabysitStatus, () => babysitStatus());

  ipcMain.handle(IPC.ListAdvisors, () => {
    try {
      return { ok: true, advisors: listAdvisors() };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.ConsultAdvisor, async (_e, payload: { personaId: string; question: string; history: { role: 'user' | 'assistant'; content: string }[]; useFullCodebase?: boolean }) => {
    try {
      const result = await consultAdvisor(
        payload.personaId,
        payload.question,
        payload.history ?? [],
        { useFullCodebase: !!payload.useFullCodebase },
      );
      return { ok: true, ...result };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.RefreshSeeds, async () => {
    try {
      const result = await runSeed(line => mainWindow?.webContents.send(IPC.RefreshSeedsLog, line));
      return result;
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), totalChunks: 0, totalFiles: 0, perAgent: [] };
    }
  });

  ipcMain.handle(IPC.ExtractActions, async (_e, payload: { question: string; reply: string; personaName: string; personaId?: string }) => {
    try {
      const actions = await extractActions(payload.question, payload.reply, payload.personaName);
      const projectId = getActiveProjectId();
      const persisted = actions.map(a => {
        const id = insertAction({
          content: a.summary,
          personaId: payload.personaId ?? null,
          projectId,
          priority: a.urgency === 'high' ? 'high' : a.urgency === 'low' ? 'low' : 'medium',
          sourceQuestion: payload.question.slice(0, 500),
        });
        return { id, ...a };
      });
      return { ok: true, actions: persisted };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), actions: [] };
    }
  });

  ipcMain.handle(IPC.ListActions, (_e, opts: { status?: string; projectId?: number | null; limit?: number } = {}) => {
    try {
      const actions = dbListActions({ status: (opts.status as any) ?? 'active', projectId: opts.projectId ?? null, limit: opts.limit ?? 200 });
      return { ok: true, actions };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), actions: [] };
    }
  });

  ipcMain.handle(IPC.CreateAction, (_e, input: { content: string; personaId?: string | null; projectId?: number | null; priority?: string; status?: string; sourceChatId?: number | null; sourceQuestion?: string | null }) => {
    try {
      if (!input.content?.trim()) return { ok: false, error: 'content required' };
      const id = insertAction({
        content: input.content.trim().slice(0, 500),
        personaId: input.personaId ?? null,
        projectId: input.projectId ?? getActiveProjectId(),
        priority: (input.priority as any) ?? 'medium',
        status: (input.status as any) ?? 'todo',
        sourceChatId: input.sourceChatId ?? null,
        sourceQuestion: input.sourceQuestion ?? null,
      });
      return { ok: true, id };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.UpdateAction, (_e, payload: { id: number; patch: any }) => {
    try {
      dbUpdateAction(payload.id, payload.patch ?? {});
      return { ok: true, action: dbGetAction(payload.id) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.UpdateActionStatus, (_e, payload: { id: number; status: string }) => {
    try {
      dbUpdateAction(payload.id, { status: payload.status as any });
      return { ok: true, action: dbGetAction(payload.id) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.DeleteAction, (_e, id: number) => {
    try {
      dbDeleteAction(id);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.GetAction, (_e, id: number) => {
    try {
      return { ok: true, action: dbGetAction(id) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), action: null };
    }
  });

  ipcMain.handle(IPC.ListCanvases, (_e, projectId: number | null) => {
    try {
      return { ok: true, canvases: dbListCanvases(projectId ?? getActiveProjectId()) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), canvases: [] };
    }
  });

  ipcMain.handle(IPC.GetCanvas, (_e, id: number) => {
    try {
      return { ok: true, canvas: dbGetCanvas(id) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), canvas: null };
    }
  });

  ipcMain.handle(IPC.CreateCanvas, (_e, input: { name: string; projectId?: number | null; stateJson?: string }) => {
    try {
      const name = (input.name?.trim() || `Canvas ${new Date().toLocaleDateString()}`).slice(0, 120);
      const id = dbCreateCanvas({ name, projectId: input.projectId ?? getActiveProjectId(), stateJson: input.stateJson ?? '{}' });
      return { ok: true, id };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.SaveCanvas, (_e, input: { id: number; stateJson: string; name?: string }) => {
    try {
      saveCanvasState(input.id, input.stateJson, input.name);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.DeleteCanvas, (_e, id: number) => {
    try {
      dbDeleteCanvas(id);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  // Photos — scans a folder (default: iCloud Photos on Windows) for
  // images and returns lightweight thumbnails via Electron's nativeImage.
  // Full-resolution images load on demand via GetPhotoFull when the user
  // actually drops one onto a canvas.
  ipcMain.handle(IPC.ListPhotos, async (_e, opts: { folder?: string; limit?: number; sinceTs?: number } = {}) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      // Default-folder fallback chain. The new iCloud-for-Windows
       //  (Microsoft Store version, Apr 2024+) auto-syncs every photo
       //  from the user's iCloud Photo Library to ~/iCloudPhotos/Photos
       //  once iCloud Drive is enabled. That's the canonical iPhone-→-PC
       //  pipeline now — wins over everything else. HiveDrop in iCloud
       //  Drive is the manual fallback for users who want a curated
       //  drop folder via the share-sheet Shortcut.
      const candidates = [
        path.join(os.homedir(), 'iCloudPhotos', 'Photos'),
        path.join(os.homedir(), 'iCloud Photos', 'Photos'),
        path.join(os.homedir(), 'iCloudDrive', 'HiveDrop'),
        path.join(os.homedir(), 'iCloud Drive', 'HiveDrop'),
        path.join(os.homedir(), 'Pictures', 'iCloud Photos', 'Photos'),
        path.join(os.homedir(), 'OneDrive', 'Pictures', 'Screenshots'),
        path.join(os.homedir(), 'Pictures'),
      ];
      const defaultFolder = candidates.find(p => fs.existsSync(p)) ?? candidates[0];
      const folder = opts.folder || defaultFolder;
      if (!fs.existsSync(folder)) {
        return { ok: true, photos: [], folder, exists: false };
      }
      const exts = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif']);
      const entries = fs.readdirSync(folder, { withFileTypes: true });
      const limit = Math.max(10, Math.min(500, opts.limit ?? 200));
      const sinceTs = opts.sinceTs && opts.sinceTs > 0 ? opts.sinceTs : 0;
      const files = entries
        .filter((e: any) => e.isFile())
        .map((e: any) => {
          const full = path.join(folder, e.name);
          let mtime = 0; let size = 0;
          try { const st = fs.statSync(full); mtime = st.mtimeMs; size = st.size; } catch {}
          return { name: e.name, path: full, mtime, size, ext: path.extname(e.name).toLowerCase() };
        })
        .filter((f: any) => exts.has(f.ext))
        .filter((f: any) => sinceTs === 0 || f.mtime >= sinceTs)
        .sort((a: any, b: any) => b.mtime - a.mtime)
        .slice(0, limit);
      const photos = files.map((f: any) => {
        let thumbDataUrl: string | null = null;
        try {
          // .heic / .heif aren't supported by Electron's nativeImage on
          // Windows — skip the thumb for those (we still surface the row).
          if (f.ext === '.heic' || f.ext === '.heif') {
            thumbDataUrl = null;
          } else {
            const img = nativeImage.createFromPath(f.path);
            if (!img.isEmpty()) {
              const thumb = img.resize({ width: 160, quality: 'good' });
              thumbDataUrl = thumb.toDataURL();
            }
          }
        } catch {}
        return { name: f.name, path: f.path, mtime: f.mtime, size: f.size, ext: f.ext, thumbDataUrl };
      });
      return { ok: true, photos, folder, exists: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), photos: [] };
    }
  });

  // Photos folder watcher — fires PhotosFolderEvent on any add/change so
  // the renderer can refresh its thumbnail grid as new screenshots land.
  let photosWatcher: any = null;
  ipcMain.handle(IPC.WatchPhotosFolder, async (_e, folder: string) => {
    try {
      if (photosWatcher) { try { photosWatcher.close(); } catch {} photosWatcher = null; }
      if (!folder) return { ok: false, error: 'no folder' };
      const fs = require('fs');
      if (!fs.existsSync(folder)) return { ok: false, error: 'folder missing' };
      photosWatcher = fs.watch(folder, { persistent: false }, (event: string, filename: string) => {
        if (!filename) return;
        mainWindow?.webContents.send(IPC.PhotosFolderEvent, { event, filename, folder });
      });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.UnwatchPhotosFolder, async () => {
    try {
      if (photosWatcher) { photosWatcher.close(); photosWatcher = null; }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.PickPhotosFolder, async () => {
    try {
      const res = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        title: 'Pick a folder of photos to surface in Hive',
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
      return { ok: true, folder: res.filePaths[0] };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.ExpandMindTopic, async (_e, payload: { personaId: string; topic: string; context?: string[] }) => {
    try {
      if (!payload?.personaId || !payload?.topic?.trim()) {
        return { ok: false, error: 'personaId + topic required', ideas: [] };
      }
      const result = await expandMindTopic(payload.personaId, payload.topic, payload.context);
      return { ok: true, ...result };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), ideas: [] };
    }
  });

  ipcMain.handle(IPC.GetPhotoFull, async (_e, photoPath: string) => {
    try {
      const fs = require('fs');
      const path = require('path');
      if (!photoPath || !fs.existsSync(photoPath)) return { ok: false, error: 'not found' };
      const ext = path.extname(photoPath).toLowerCase();
      if (ext === '.heic' || ext === '.heif') {
        return { ok: false, error: 'HEIC not supported — set iPhone to "Most Compatible" or convert.' };
      }
      const img = nativeImage.createFromPath(photoPath);
      if (img.isEmpty()) return { ok: false, error: 'could not decode' };
      return { ok: true, dataUrl: img.toDataURL() };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.RunCouncil, async (_e, payload: string | { question: string; useFullCodebase?: boolean }) => {
    try {
      const question = typeof payload === 'string' ? payload : payload.question;
      const useFullCodebase = typeof payload === 'object' && !!payload.useFullCodebase;
      const result = await runCouncil(question, { useFullCodebase });
      return { ok: true, ...result };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.RunShipAudit, async () => {
    try {
      const result = await runShipAudit(evt => mainWindow?.webContents.send(IPC.ShipAuditProgress, evt));
      return { ok: true, ...result };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.ListAlerts, (_e, status: string) => {
    try {
      const alerts = dbListAlerts({ status: (status as any) ?? 'open', limit: 200 });
      return { ok: true, alerts };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), alerts: [] };
    }
  });
  ipcMain.handle(IPC.AckAlert, (_e, id: number) => {
    try { setAlertStatus(id, 'acked'); return { ok: true }; }
    catch (err: any) { return { ok: false, error: err?.message ?? String(err) }; }
  });
  ipcMain.handle(IPC.DeleteAlert, (_e, id: number) => {
    try { deleteAlertRow(id); return { ok: true }; }
    catch (err: any) { return { ok: false, error: err?.message ?? String(err) }; }
  });
  ipcMain.handle(IPC.PollAlertsNow, async () => {
    try {
      const results = await pollAllOnce(evt => mainWindow?.webContents.send(IPC.AlertEvent, evt));
      return { ok: true, results };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.AlertsConfig, () => alertsConfig());

  // Kick off background polling. 10 min interval; first poll fires
  // immediately so the user sees alerts on launch if any sources are wired.
  const ALERT_POLL_MS = Number(process.env.HIVE_ALERTS_INTERVAL_MS) || 10 * 60 * 1000;
  startAlertsPolling(ALERT_POLL_MS, evt => mainWindow?.webContents.send(IPC.AlertEvent, evt));

  // ---- Deploy --------------------------------------------------------
  // On boot, mark any deploys stuck in 'executing' (i.e. crashed mid-run)
  // as 'failed' so the history view tells the truth.
  const stuckCount = reconcileStuckDeploys();
  if (stuckCount > 0) console.warn(`[deploy] reconciled ${stuckCount} stuck 'executing' row(s) on boot`);

  ipcMain.handle(IPC.ExtractDeployIntent, async (_e, text: string) => {
    try {
      const intent = await deployExtractIntent(String(text ?? ''));
      return { ok: true, ...intent };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.PrepareDeploy, async (_e, input: { project: string; channel: 'preview' | 'production'; message: string; skipTypecheck?: boolean }) => {
    try {
      const plan = await deployPreparePlan({
        project: input.project,
        channel: input.channel,
        message: input.message,
        skipTypecheck: !!input.skipTypecheck,
        onLine: (line) => mainWindow?.webContents.send(IPC.DeployLog, line),
      });
      return { ok: true, plan };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.ExecuteDeploy, async (_e, input: { planId: string; confirmation: string }) => {
    try {
      const result = await deployExecutePlan({
        planId: input.planId,
        confirmation: input.confirmation,
        onLine: (line) => mainWindow?.webContents.send(IPC.DeployLog, line),
      });
      return result;
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), deployId: -1, groupId: null, durationMs: 0, log: [], smoke: null };
    }
  });
  ipcMain.handle(IPC.RollbackDeploy, async (_e, input: { project: string; channel: 'preview' | 'production'; toGroupId: string; reason: string }) => {
    try {
      const result = await deployRollback({
        project: input.project,
        channel: input.channel,
        toGroupId: input.toGroupId,
        reason: input.reason,
        onLine: (line) => mainWindow?.webContents.send(IPC.DeployLog, line),
      });
      return result;
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), deployId: -1, groupId: null, durationMs: 0, log: [], smoke: null };
    }
  });
  ipcMain.handle(IPC.ListDeploys, (_e, limit?: number) => {
    try {
      return { ok: true, deploys: deployHistory(typeof limit === 'number' ? limit : 20) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), deploys: [] };
    }
  });

  // ---- Pulse + chats ------------------------------------------------
  ipcMain.handle(IPC.GetPulse, () => {
    try { return { ok: true, pulse: pulseGet() }; }
    catch (err: any) { return { ok: false, error: err?.message ?? String(err) }; }
  });
  ipcMain.handle(IPC.MarkPulseSeen, () => {
    try { pulseMarkSeen(); return { ok: true }; }
    catch (err: any) { return { ok: false, error: err?.message ?? String(err) }; }
  });
  ipcMain.handle(IPC.ListPersonaChats, (_e, payload: { personaId: string; limit?: number }) => {
    try {
      return { ok: true, chats: listChatsForPersona(payload.personaId, payload.limit ?? 100) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), chats: [] };
    }
  });
  ipcMain.handle(IPC.GetCellPreviews, (_e, personaIds: string[]) => {
    try {
      return { ok: true, previews: previewByPersona(Array.isArray(personaIds) ? personaIds : []) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), previews: {} };
    }
  });

  // ---- Drafts (fxv-content) ------------------------------------------
  ipcMain.handle(IPC.ListDrafts, () => {
    try { return { ok: true, drafts: draftsList() }; }
    catch (err: any) { return { ok: false, error: err?.message ?? String(err), drafts: [] }; }
  });
  ipcMain.handle(IPC.OpenDraftFolder, (_e, slug: string) => openDraftFolderInExplorer(String(slug ?? '')));
  ipcMain.handle(IPC.OpenDraftHero, (_e, slug: string) => openHeroInPlayer(String(slug ?? '')));

  // ---- Content pipeline ----------------------------------------------
  ipcMain.handle(IPC.GenerateNextDraft, async () => {
    try {
      const res = await pipelineGenerate({
        onProgress: (evt) => mainWindow?.webContents.send(IPC.ContentDraftProgress, evt),
      });
      return res;
    } catch (err: any) {
      return { ok: false, draftPath: null, durationMs: 0, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.GetContentQueue, () => {
    try { return { ok: true, queue: pipelineGetQueue() }; }
    catch (err: any) { return { ok: false, error: err?.message ?? String(err) }; }
  });

  ipcMain.handle(IPC.GetWorkerDiff, async (_e, workerId: string) => {
    try {
      const result = await diffWorkerBranch(workerId);
      return { ok: true, ...result };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.DeleteProject, async (_e, id: number) => {
    if (id === 1) return { ok: false, error: 'cannot delete the default project' };
    const activeId = getActiveProjectId();
    if (activeId === id) return { ok: false, error: 'switch to another project first' };
    const proj = getProject(id);
    if (!proj) return { ok: false, error: 'project not found' };
    deleteProject(id);
    return { ok: true };
  });
  ipcMain.handle(IPC.RunSpecInterview, async (_e, task: string) => {
    if (!orchestrator) return { ok: false, questions: [] };
    try {
      const questions = await orchestrator.runSpecInterview(task);
      return { ok: true, questions };
    } catch (err: any) {
      return { ok: false, questions: [], error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.ListTemplates, () => listTemplates());
  ipcMain.handle(IPC.ScaffoldTemplate, async (_e, payload: { workerId: string; templateName: string; projectName: string }) => {
    // v1.0 Project mode — templates scaffold into the parent project repo so
    // every worker dispatch branches off a populated codebase. workerId is
    // kept on the IPC surface for log attribution but no longer affects path.
    try {
      await ensureProjectRepo();
      const dir = projectDir();
      const logId = 'M';
      const result = await scaffoldTemplate(dir, payload.templateName, payload.projectName, (line) => {
        mainWindow?.webContents.send(IPC.AgentEvent, { type: 'log', id: logId, line });
      });
      if (result.ok) {
        const committed = await commitProjectChanges(`scaffold: ${result.template}`).catch(() => false);
        const tag = committed ? ' + committed to main' : '';
        mainWindow?.webContents.send(IPC.AgentEvent, { type: 'log', id: logId, line: `✓ scaffolded ${result.template} (${result.filesWritten.length} files)${tag}` });
      } else {
        mainWindow?.webContents.send(IPC.AgentEvent, { type: 'log', id: logId, line: `✗ scaffold failed: ${result.error}` });
      }
      return result;
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle(IPC.Speak, async (_e, text: string) => {
    try {
      const bytes = await speak(text);
      return { ok: true, bytes: bytes.buffer };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  stopAlertsPolling();
  orchestrator?.shutdown();
  shutdownAllMcp().catch(() => { /* ignore */ });
  shutdownDb();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  shutdownAllMcp().catch(() => { /* ignore */ });
  shutdownDb();
});
