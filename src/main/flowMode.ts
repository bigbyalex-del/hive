import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';
import * as http from 'http';
import { IPC } from '../shared/types';

const FXV_PATH = 'C:\\Users\\Fusion\\.openclaw\\workspace\\fxv-performance\\mobile';
const PORT = 8081;

type FlowState = 'idle' | 'starting' | 'ready' | 'error' | 'stopping';

interface FlowSnapshot {
  state: FlowState;
  url: string | null;
  projectPath: string;
  message: string | null;
  startedAt: number | null;
}

let proc: ChildProcess | null = null;
let state: FlowState = 'idle';
let message: string | null = null;
let startedAt: number | null = null;
let mainWindow: BrowserWindow | null = null;

function emitLog(line: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.FlowLog, { line, ts: Date.now() });
  }
}

function emitStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.FlowStatus, snapshot());
  }
}

function setState(next: FlowState, msg: string | null = '__keep__') {
  state = next;
  if (msg !== '__keep__') message = msg;
  emitStatus();
}

export function attachWindow(win: BrowserWindow) {
  mainWindow = win;
}

export function snapshot(): FlowSnapshot {
  return {
    state,
    url: state === 'ready' ? `http://localhost:${PORT}` : null,
    projectPath: FXV_PATH,
    message,
    startedAt,
  };
}

async function isReady(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host: 'localhost', port: PORT, path: '/', timeout: 1500 }, res => {
      // Expo dev server returns 200 once the bundle endpoint is up.
      res.resume();
      resolve(res.statusCode != null && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function pollUntilReady(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isReady()) return true;
    await new Promise(r => setTimeout(r, 800));
  }
  return false;
}

export async function start(): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (proc && !proc.killed) {
    return { ok: state === 'ready', url: state === 'ready' ? `http://localhost:${PORT}` : undefined, error: state === 'ready' ? undefined : 'flow already starting' };
  }
  setState('starting', 'Spawning expo start --web…');
  startedAt = Date.now();
  emitLog(`[flow] spawning npx expo start --web --port ${PORT} in ${FXV_PATH}`);

  // npx.cmd is the Windows shim; shell:true keeps PATH lookup working.
  proc = spawn('npx', ['expo', 'start', '--web', '--port', String(PORT)], {
    cwd: FXV_PATH,
    shell: true,
    env: {
      ...process.env,
      // CI=1 suppresses Expo's interactive UI but keeps logs.
      CI: '1',
      // Tell Expo not to open a browser tab on our behalf.
      BROWSER: 'none',
    },
  });

  proc.stdout?.on('data', (buf: Buffer) => {
    const text = buf.toString();
    text.split(/\r?\n/).filter(Boolean).forEach(emitLog);
  });
  proc.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString();
    text.split(/\r?\n/).filter(Boolean).forEach(line => emitLog(`[stderr] ${line}`));
  });
  proc.on('exit', (code, signal) => {
    emitLog(`[flow] expo exited code=${code} signal=${signal ?? ''}`);
    proc = null;
    if (state !== 'stopping') setState('error', `expo exited (code ${code})`);
    else setState('idle', null);
    startedAt = null;
  });
  proc.on('error', err => {
    emitLog(`[flow] spawn error: ${err.message}`);
    setState('error', err.message);
  });

  const ready = await pollUntilReady(120_000); // expo first-build can be slow
  if (!ready) {
    setState('error', 'expo dev server did not become ready within 2 minutes');
    return { ok: false, error: 'expo did not become ready' };
  }
  setState('ready', 'dev server up');
  return { ok: true, url: `http://localhost:${PORT}` };
}

export async function stop(): Promise<{ ok: boolean }> {
  if (!proc || proc.killed) {
    setState('idle', null);
    return { ok: true };
  }
  setState('stopping', 'killing expo…');
  try {
    // On Windows, taskkill the process tree — expo spawns metro + watchman children.
    if (process.platform === 'win32' && proc.pid != null) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { shell: true });
    } else {
      proc.kill('SIGTERM');
    }
  } catch (err: any) {
    emitLog(`[flow] kill error: ${err.message}`);
  }
  proc = null;
  setState('idle', null);
  return { ok: true };
}

export function isRunning(): boolean {
  return proc != null && !proc.killed;
}
