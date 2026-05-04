// Whisper STT — receives audio bytes from the renderer and returns a transcript.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

let cachedClient: any = null;
async function getOpenAI() {
  if (cachedClient) return cachedClient;
  const mod = await dynamicImport('openai');
  const Ctor = mod.default ?? mod.OpenAI;
  cachedClient = new Ctor({ apiKey: process.env.OPENAI_API_KEY });
  return cachedClient;
}

export async function transcribeAudio(bytes: Uint8Array, mime: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing in .env — needed for Whisper voice input.');
  }

  // Whisper expects a file. Write a temp file in a format it accepts.
  const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
  const tmpPath = path.join(os.tmpdir(), `hive-voice-${Date.now()}.${ext}`);
  fs.writeFileSync(tmpPath, bytes);

  try {
    const client = await getOpenAI();
    // gpt-4o-mini-transcribe is ~2x faster than whisper-1 with comparable
    // accuracy. Falls back to whisper-1 if the project doesn't have access.
    let resp;
    try {
      resp = await client.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: 'gpt-4o-mini-transcribe',
        response_format: 'text',
      });
    } catch (err: any) {
      if (err?.status === 404 || err?.status === 400) {
        resp = await client.audio.transcriptions.create({
          file: fs.createReadStream(tmpPath),
          model: 'whisper-1',
          response_format: 'text',
        });
      } else {
        throw err;
      }
    }
    return typeof resp === 'string' ? resp.trim() : (resp.text ?? '').trim();
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}
