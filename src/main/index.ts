import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron';
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
import { projectDir, commitProjectChanges, ensureProjectRepo, diffWorkerBranch } from './projectRepo';

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

function injectPreviewType(projectType: string) {
  if (!previewWindow || previewWindow.isDestroyed()) return;
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
    const dir = workerId === 'project'
      ? projectDir()
      : path.join(process.cwd(), 'worktrees', `wt-${workerId.replace(/^W/i, '')}`);
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
    const dir = payload.workerId === 'project'
      ? projectDir()
      : path.join(process.cwd(), 'worktrees', `wt-${payload.workerId.replace(/^W/i, '')}`);
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
