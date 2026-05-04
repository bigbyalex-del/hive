// Text-to-speech via OpenAI. Returns mp3 bytes for the renderer to play.

const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

let cached: any = null;
async function getOpenAI() {
  if (cached) return cached;
  const mod = await dynamicImport('openai');
  const Ctor = mod.default ?? mod.OpenAI;
  cached = new Ctor({ apiKey: process.env.OPENAI_API_KEY });
  return cached;
}

export async function speak(text: string, voice = 'nova'): Promise<Uint8Array> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing — needed for TTS.');
  }
  if (!text.trim()) return new Uint8Array();

  const client = await getOpenAI();
  const resp = await client.audio.speech.create({
    model: 'tts-1',
    voice,
    input: text.slice(0, 4000), // OpenAI hard limit
    response_format: 'mp3',
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  return new Uint8Array(buf);
}
