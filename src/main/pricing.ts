// Per-model pricing for the cost dashboard. Numbers in GBP per 1M tokens —
// the providers publish USD per 1M, so we apply a conservative 0.80 USD→GBP
// conversion baked into the table. Refresh quarterly when rates drift.
//
// Source: docs.anthropic.com / openai.com / ai.google.dev (Jan 2026 prices).

export interface ModelPrice {
  inputPerM: number;   // GBP per 1,000,000 input tokens
  outputPerM: number;  // GBP per 1,000,000 output tokens
}

const USD_TO_GBP = 0.80;

function usd(input: number, output: number): ModelPrice {
  return { inputPerM: +(input * USD_TO_GBP).toFixed(4), outputPerM: +(output * USD_TO_GBP).toFixed(4) };
}

// Anthropic Claude 4.x pricing (as of Jan 2026). Cached reads are billed at
// 0.1× input — we ignore that here for simplicity and slightly over-report,
// which is the right side to err on.
const PRICES: Record<string, ModelPrice> = {
  // Anthropic
  'claude-opus-4-7':            usd(15.00, 75.00),
  'claude-sonnet-4-6':          usd( 3.00, 15.00),
  'claude-haiku-4-5-20251001':  usd( 1.00,  5.00),

  // OpenAI (rough — placeholders for now, used only if user wires OpenAI)
  'gpt-5':                      usd(10.00, 40.00),
  'gpt-5-mini':                 usd( 0.30,  1.20),
  'gpt-4o':                     usd( 2.50, 10.00),

  // Google
  'gemini-2.5-pro':             usd( 1.25,  5.00),
  'gemini-2.5-flash':           usd( 0.30,  2.50),
};

export function priceFor(model: string): ModelPrice {
  return PRICES[model] ?? { inputPerM: 0, outputPerM: 0 };
}

export function costGBP(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens / 1_000_000) * p.inputPerM + (outputTokens / 1_000_000) * p.outputPerM;
}

export function knownModels(): string[] { return Object.keys(PRICES); }
