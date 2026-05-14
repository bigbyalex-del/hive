// Common interface every model provider must implement so agents can swap freely.

export type ProviderName = 'anthropic' | 'openai' | 'google';

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
}

export interface ToolDef {
  name: string;
  description: string;
  // JSON-schema for parameters
  schema: Record<string, any>;
  run: (input: any) => Promise<string>;
}

export interface RunOptions {
  systemPrompt: string;
  prompt: string;
  tools?: ToolDef[];
  maxTurns?: number;
  cwd?: string; // working directory for file tools
  abortSignal?: AbortSignal; // user-cancel
  noTools?: boolean; // Manager-style: pure text routing, no tools injected
  // Optional large prefix block placed BEFORE systemPrompt, separately cached.
  // Used for full-codebase mode so the same snapshot can be shared across
  // every persona call (Council/Ship Audit) — one cache write, many reads.
  cachedPrefix?: string;
}

export interface RunResult {
  text: string;          // final assistant message
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface RunEvents {
  onText?: (delta: string) => void;
  onToolCall?: (name: string, input: any) => void;
  onToolResult?: (name: string, result: string) => void;
  onError?: (err: Error) => void;
}

export interface Provider {
  name: ProviderName;
  models: string[];
  run(model: string, opts: RunOptions, events: RunEvents): Promise<RunResult>;
}
