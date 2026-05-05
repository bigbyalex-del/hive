// Headless self-test for worker output — uses Electron's bundled Chromium
// instead of a separate Playwright install. A hidden BrowserWindow loads the
// worker's HTML via file://, optionally runs a JS assertion in page context,
// and captures a PNG. Used by the BrowserTest tool so workers can verify their
// own UI before reporting done.

import { BrowserWindow } from 'electron';
import * as fs from 'fs/promises';

export interface BrowserTestOptions {
  htmlPathAbs: string;     // absolute path to the .html file
  assertion?: string;      // JS snippet evaluated in page context; truthy = pass
  screenshotPathAbs: string;
  timeoutMs?: number;      // default 10s
}

export interface BrowserTestResult {
  ok: boolean;
  error?: string;
  consoleLogs: string[];   // captured page console output (useful for debugging)
}

export async function runBrowserTest(opts: BrowserTestOptions): Promise<BrowserTestResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const consoleLogs: string[] = [];

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // file:// URLs to local resources need webSecurity off; the page is
      // worker-generated content we already own, so the surface is acceptable.
      webSecurity: false,
    },
  });

  win.webContents.on('console-message', (_e, _level, message) => {
    consoleLogs.push(message.slice(0, 200));
    if (consoleLogs.length > 20) consoleLogs.shift();
  });

  const cleanup = () => {
    if (!win.isDestroyed()) win.close();
  };

  // Hard timeout so a runaway page can't hang a worker.
  const timer = setTimeout(() => {
    consoleLogs.push(`(timeout after ${timeoutMs}ms)`);
    cleanup();
  }, timeoutMs);

  try {
    const url = 'file:///' + opts.htmlPathAbs.replace(/\\/g, '/');
    await win.loadURL(url);
    // Brief settle so deferred scripts / images / fonts have a chance.
    await new Promise(r => setTimeout(r, 250));

    if (opts.assertion) {
      const wrapped = `(async () => { ${opts.assertion} })()`;
      let assertResult: any;
      try {
        assertResult = await win.webContents.executeJavaScript(wrapped, true);
      } catch (e: any) {
        return { ok: false, error: `assertion threw: ${e?.message ?? e}`, consoleLogs };
      }
      if (!assertResult) {
        return { ok: false, error: 'assertion returned falsy', consoleLogs };
      }
    }

    const img = await win.webContents.capturePage();
    await fs.writeFile(opts.screenshotPathAbs, img.toPNG());
    return { ok: true, consoleLogs };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), consoleLogs };
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}
