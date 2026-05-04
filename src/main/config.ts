// Per-agent model config, persisted to disk so settings survive restart.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { ProviderConfig } from './providers/types';

export type ModelConfig = Record<string, ProviderConfig>; // keyed by agent id (M, W1..W8)

const DEFAULTS: ModelConfig = {
  // Manager defaults to Sonnet 4.6 — routing/decomposition is well within
  // Sonnet's range and it responds 2-3x faster than Opus, which makes voice
  // chat snappy. User can promote to Opus via ⚙ panel for hard tasks.
  M:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  // Haiku 4.5 is 3-5x faster + ~5x cheaper than Sonnet for the bulk of tasks
  // (HTML/CSS pages, file edits, simple refactors). User can swap individual
  // workers to Sonnet via the ⚙ models panel for harder work.
  W1: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  W2: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  W3: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  W4: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  W5: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  W6: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  W7: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  W8: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

let cached: ModelConfig | null = null;

function configPath(): string {
  // app.getPath only works after Electron ready; fall back for tests.
  const dir = app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.hive');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'models.json');
}

export function getModelConfig(): ModelConfig {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    cached = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached!;
}

export function setModelConfig(cfg: ModelConfig): void {
  cached = { ...DEFAULTS, ...cfg };
  fs.writeFileSync(configPath(), JSON.stringify(cached, null, 2), 'utf8');
}

export function getAgentConfig(id: string): ProviderConfig {
  return getModelConfig()[id] ?? DEFAULTS[id] ?? { provider: 'anthropic', model: 'claude-sonnet-4-6' };
}
