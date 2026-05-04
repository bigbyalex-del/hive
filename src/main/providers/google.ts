// Google Gemini provider — same agent loop interface. Stub for v0.1.
// Full implementation lands when @google/generative-ai is added.

import { Provider, RunOptions, RunResult, RunEvents } from './types';

export class GoogleProvider implements Provider {
  name = 'google' as const;
  models = ['gemini-2.5-pro', 'gemini-2.5-flash'];

  async run(_model: string, _opts: RunOptions, _events: RunEvents): Promise<RunResult> {
    throw new Error('GoogleProvider not yet implemented — install @google/generative-ai and complete src/main/providers/google.ts.');
  }
}
