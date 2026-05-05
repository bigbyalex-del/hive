// Per-agent model config, persisted to disk so settings survive restart.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { ProviderConfig } from './providers/types';

export type ModelConfig = Record<string, ProviderConfig>; // keyed by agent id (M, W1..W8)

const DEFAULTS: ModelConfig = {
  // Role-tiered defaults (v0.6): Manager handles routing only — Sonnet is plenty
  // and stays snappy for voice chat. W1 is the "primary coder" — Sonnet for
  // multi-step reasoning across files. W2-W7 are fan-out workers tackling
  // pattern-work in parallel — Haiku for 5x cheaper, 3x faster turns. W8 is
  // earmarked for the Reviewer pass (v0.7) — Haiku is enough for diff review.
  // Users override per-agent via the ⚙ models panel.
  M:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  W1: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  W2: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  W3: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  W4: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  W5: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  W6: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  W7: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  W8: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  R:  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }, // Reviewer (v0.7+)
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
