/**
 * Claude / Anthropic Provider
 */

import { DEFAULTS } from '../../config/llm.js';
import type { LLMConfig } from '../../config/types.js';
import { ClaudeFormat } from '../formats/claude.js';
import { LLMProvider } from './base.js';

export function createClaudeProvider(config: LLMConfig): LLMProvider {
  const defaults = DEFAULTS.claude;
  const model = config.model || String(defaults.model ?? 'claude-sonnet-4-6');
  const baseUrl = (config.baseUrl || defaults.baseUrl || '').replace(/\/+$/, '');

  return new LLMProvider(
    new ClaudeFormat(model, config.promptCache ?? config.promptCaching, config.autoCaching),
    {
      url: config.endpoint?.url || `${baseUrl}/messages`,
      streamUrl: config.endpoint?.streamUrl,
      headers: {
        'x-api-key': config.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        ...config.headers,
        ...config.endpoint?.headers,
      },
      fetch: config.fetch,
      debug: config.debug,
      proxy: config.endpoint?.proxy ?? config.proxy,
    },
    config.name ?? 'Claude',
    config.requestBody,
    'claude',
  );
}
