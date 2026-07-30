import { ClaudeFormat } from '../llm/formats/claude.js';
import { GeminiFormat } from '../llm/formats/gemini.js';
import { OpenAICompatibleFormat } from '../llm/formats/openai-compatible.js';
import { OpenAIResponsesFormat } from '../llm/formats/openai-responses.js';
import type { LLMPromptCacheConfig } from '../config/types.js';
import type { FormatAdapter } from '../llm/formats/types.js';
import { NamedRegistry } from './named-registry.js';

export interface FormatFactoryOptions {
  model?: string;
  promptCache?: LLMPromptCacheConfig;
  promptCaching?: boolean;
  autoCaching?: boolean;
}

export type FormatAdapterFactory = (options?: FormatFactoryOptions) => FormatAdapter;

export class FormatRegistry extends NamedRegistry<FormatAdapterFactory> {}

export function createBuiltinFormatRegistry(): FormatRegistry {
  const registry = new FormatRegistry();
  registry.register('gemini', () => new GeminiFormat());
  registry.register('claude', (options) => new ClaudeFormat(options?.model ?? 'claude-sonnet-4-6', options?.promptCache ?? options?.promptCaching, options?.autoCaching));
  registry.register('openai-compatible', (options) => new OpenAICompatibleFormat(options?.model ?? 'gpt-4o'));
  registry.register('openai-responses', (options) => new OpenAIResponsesFormat(options?.model ?? 'gpt-4o', options?.promptCache));
  registry.register('deepseek', (options) => new OpenAICompatibleFormat(options?.model ?? 'deepseek-v4-flash'));
  return registry;
}
