/**
 * OpenAI Compatible Provider
 */

import { DEFAULTS } from '../../config/llm.js';
import type { LLMConfig } from '../../config/types.js';
import { OpenAICompatibleFormat } from '../formats/openai-compatible.js';
import { LLMProvider } from './base.js';

export function createOpenAICompatibleProvider(config: LLMConfig): LLMProvider {
  const defaults = DEFAULTS['openai-compatible'];
  const model = config.model || String(defaults.model ?? 'gpt-4o');
  const baseUrl = (config.baseUrl || defaults.baseUrl || '').replace(/\/+$/, '');

  return new LLMProvider(
    new OpenAICompatibleFormat(model),
    {
      url: config.endpoint?.url || `${baseUrl}/chat/completions`,
      streamUrl: config.endpoint?.streamUrl,
      headers: {
        Authorization: `Bearer ${config.apiKey ?? ''}`,
        ...config.headers,
        ...config.endpoint?.headers,
      },
      fetch: config.fetch,
      debug: config.debug,
      proxy: config.endpoint?.proxy ?? config.proxy,
    },
    config.name ?? 'OpenAICompatible',
    config.requestBody,
    'openai-compatible',
  );
}
