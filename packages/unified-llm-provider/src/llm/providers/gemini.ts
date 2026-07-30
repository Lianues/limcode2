/**
 * Gemini Provider
 */

import { DEFAULTS } from '../../config/llm.js';
import type { LLMConfig } from '../../config/types.js';
import { GeminiFormat } from '../formats/gemini.js';
import { LLMProvider } from './base.js';

export function createGeminiProvider(config: LLMConfig): LLMProvider {
  const defaults = DEFAULTS.gemini;
  const model = config.model || String(defaults.model ?? 'gemini-2.0-flash');
  const baseUrl = (config.baseUrl || defaults.baseUrl || '').replace(/\/+$/, '');

  return new LLMProvider(
    new GeminiFormat(),
    {
      url: config.endpoint?.url || `${baseUrl}/models/${model}:generateContent`,
      streamUrl: config.endpoint?.streamUrl || `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`,
      headers: {
        'x-goog-api-key': config.apiKey ?? '',
        ...config.headers,
        ...config.endpoint?.headers,
      },
      fetch: config.fetch,
      debug: config.debug,
      proxy: config.endpoint?.proxy ?? config.proxy,
    },
    config.name ?? 'Gemini',
    config.requestBody,
    'gemini',
  );
}
