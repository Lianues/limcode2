/**
 * DeepSeek Provider
 *
 * DeepSeek 走 OpenAI Chat Completions 兼容格式，
 * 但在独立包里允许用户自定义 baseUrl / endpoint。
 */

import { DEFAULTS } from '../../config/llm.js';
import type { LLMConfig } from '../../config/types.js';
import { OpenAICompatibleFormat } from '../formats/openai-compatible.js';
import { LLMProvider } from './base.js';

export function createDeepSeekProvider(config: LLMConfig): LLMProvider {
  const defaults = DEFAULTS.deepseek;
  const model = config.model || String(defaults.model ?? 'deepseek-v4-flash');
  const baseUrl = (config.baseUrl || defaults.baseUrl || '').replace(/\/+$/, '');

  return new LLMProvider(
    new OpenAICompatibleFormat(model, 'deepseek'),
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
    config.name ?? 'DeepSeek',
    config.requestBody,
    'deepseek',
  );
}
