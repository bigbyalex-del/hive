import { desktopCapturer, screen, clipboard, nativeImage } from 'electron';
import { exec } from 'child_process';

// Full primary display capture — instant, no UI.
export async function captureScreen(): Promise<{ dataUrl: string; width: number; height: number }> {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });

  if (sources.length === 0) throw new Error('no screen sources available');

  const primaryId = String(primary.id);
  const source = sources.find(s => s.display_id === primaryId) ?? sources[0];
  const png = source.thumbnail.toPNG();
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  return { dataUrl, width, height };
}

// Triggers Windows Snip & Sketch (the familiar drag-region UI), then watches
// the clipboard for the resulting image. First image to appear is returned.
// Times out after 60s if user cancels (Esc).
export async function snipRegion(): Promise<{ dataUrl: string; width: number; height: number }> {
  // Snapshot whatever's on the clipboard now so we can detect a NEW image later.
  const beforeBuf = clipboard.readImage().toPNG();

  // Launch Windows' Snip & Sketch in capture mode.
  exec('cmd /c start ms-screenclip:', (err) => {
    if (err) console.error('[snip] failed to launch ms-screenclip:', err);
  });

  // Poll clipboard for a new image for up to 60s.
  const timeoutMs = 60_000;
  const pollMs = 250;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, pollMs));
    const img = clipboard.readImage();
    if (img.isEmpty()) continue;

    const png = img.toPNG();
    // Skip if this is the same bytes that were already there before snip started.
    if (png.length === beforeBuf.length && png.equals(beforeBuf)) continue;

    const size = img.getSize();
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    return { dataUrl, width: size.width, height: size.height };
  }

  throw new Error('snip cancelled or timed out (60s)');
}

// Attempts a Windows-native fullscreen capture by sending PrintScreen via the
// shell — kept as a fallback if needed later. Currently unused.
export function _placeholder() { return nativeImage.createEmpty(); }
