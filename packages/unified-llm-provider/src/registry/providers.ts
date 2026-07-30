import type { LLMConfig } from '../config/types.js';
import type { LLMProviderLike } from '../llm/providers/base.js';
import { createClaudeProvider } from '../llm/providers/claude.js';
import { createDeepSeekProvider } from '../llm/providers/deepseek.js';
import { createGeminiProvider } from '../llm/providers/gemini.js';
import { createOpenAICompatibleProvider } from '../llm/providers/openai-compatible.js';
import { createOpenAIResponsesProvider } from '../llm/providers/openai-responses.js';
import { NamedRegistry } from './named-registry.js';

export type LLMProviderFactory = (config: LLMConfig) => LLMProviderLike;

export class LLMProviderFactoryRegistry extends NamedRegistry<LLMProviderFactory> {}

export function createBuiltinProviderRegistry(): LLMProviderFactoryRegistry {
  const registry = new LLMProviderFactoryRegistry();
  registry.register('gemini', (config) => createGeminiProvider(config));
  registry.register('claude', (config) => createClaudeProvider(config));
  registry.register('openai-compatible', (config) => createOpenAICompatibleProvider(config));
  registry.register('openai-responses', (config) => createOpenAIResponsesProvider(config));
  registry.register('deepseek', (config) => createDeepSeekProvider(config));
  return registry;
}
