import { Provider, ProviderName } from './types';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GoogleProvider } from './google';

const providers: Record<ProviderName, Provider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAIProvider(),
  google: new GoogleProvider(),
};

export function getProvider(name: ProviderName): Provider {
  const p = providers[name];
  if (!p) throw new Error(`unknown provider: ${name}`);
  return p;
}

export function listProviders(): { name: ProviderName; models: string[] }[] {
  return Object.values(providers).map(p => ({ name: p.name, models: p.models }));
}
