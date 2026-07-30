import type { LLMConfig, LLMModelDef, LLMRegistryConfig, LLMPromptCacheConfig, LLMPromptCacheMode, LLMPromptCacheTtl } from './types.js';

export const DEFAULT_MODEL_NAME = 'default';

export const DEFAULTS: Record<string, Partial<LLMConfig> & { contextWindow?: number }> = {
  deepseek: {
    format: 'openai-compatible',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    contextWindow: 1_000_000,
  },
  gemini: {
    format: 'gemini',
    model: 'gemini-2.0-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    contextWindow: 1_048_576,
  },
  'openai-compatible': {
    format: 'openai-compatible',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 128_000,
  },
  claude: {
    format: 'claude',
    model: 'claude-sonnet-4-6',
    baseUrl: 'https://api.anthropic.com/v1',
    contextWindow: 200_000,
  },
  'openai-responses': {
    format: 'openai-responses',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 128_000,
  },
};

export function parseSingleLLMConfig(raw: unknown = {}): LLMConfig {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const { timeoutMs: _timeoutMs, streamTimeoutMs: _streamTimeoutMs, ...restSource } = source;
  const provider = String(source.provider ?? 'gemini');
  const defaults = DEFAULTS[provider] ?? {};

  return {
    ...restSource,
    provider,
    format: typeof source.format === 'string' ? source.format : defaults.format,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : undefined,
    model: typeof source.model === 'string' && source.model.trim() ? source.model : String(defaults.model ?? ''),
    baseUrl: typeof source.baseUrl === 'string' && source.baseUrl.trim()
      ? source.baseUrl
      : defaults.baseUrl,
    contextWindow: typeof source.contextWindow === 'number' ? source.contextWindow : defaults.contextWindow,
    supportsVision: typeof source.supportsVision === 'boolean' ? source.supportsVision : undefined,
    headers: source.headers && typeof source.headers === 'object' && !Array.isArray(source.headers)
      ? source.headers as Record<string, string>
      : undefined,
    requestBody: source.requestBody && typeof source.requestBody === 'object' && !Array.isArray(source.requestBody)
      ? source.requestBody as Record<string, unknown>
      : undefined,
    endpoint: source.endpoint && typeof source.endpoint === 'object' && !Array.isArray(source.endpoint)
      ? source.endpoint as LLMConfig['endpoint']
      : undefined,
    promptCache: normalizePromptCacheConfig(source.promptCache),
    promptCaching: source.promptCaching === true ? true : undefined,
    autoCaching: source.autoCaching === true ? true : undefined,
    fetch: typeof source.fetch === 'function' ? source.fetch as LLMConfig['fetch'] : undefined,
    debug: source.debug && typeof source.debug === 'object' && !Array.isArray(source.debug)
      ? source.debug as LLMConfig['debug']
      : undefined,
    name: typeof source.name === 'string' ? source.name : undefined,
  };
}

function normalizePromptCacheConfig(input: unknown): LLMPromptCacheConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const breakpoints = source.breakpoints && typeof source.breakpoints === 'object' && !Array.isArray(source.breakpoints)
    ? source.breakpoints as Record<string, unknown>
    : undefined;
  const normalizedBreakpoints = breakpoints
    ? {
      ...(typeof breakpoints.system === 'boolean' ? { system: breakpoints.system } : {}),
      ...(typeof breakpoints.tools === 'boolean' ? { tools: breakpoints.tools } : {}),
      ...(typeof breakpoints.messages === 'boolean' ? { messages: breakpoints.messages } : {}),
    } satisfies NonNullable<LLMPromptCacheConfig['breakpoints']>
    : undefined;
  const ttl = normalizePromptCacheTtl(source.ttl);
  const mode = normalizePromptCacheMode(source.mode);
  const key = typeof source.key === 'string' && source.key.trim() ? source.key.trim() : undefined;
  const config: LLMPromptCacheConfig = {
    ...(typeof source.enabled === 'boolean' ? { enabled: source.enabled } : {}),
    ...(key ? { key } : {}),
    ...(ttl ? { ttl } : {}),
    ...(mode ? { mode } : {}),
    ...(normalizedBreakpoints && Object.keys(normalizedBreakpoints).length > 0 ? { breakpoints: normalizedBreakpoints } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

function normalizePromptCacheTtl(value: unknown): LLMPromptCacheTtl | undefined {
  return value === '5m' || value === '30m' || value === '1h' ? value : undefined;
}

function normalizePromptCacheMode(value: unknown): LLMPromptCacheMode | undefined {
  return value === 'key' || value === 'implicit' || value === 'explicit' ? value : undefined;
}

function normalizeModelName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toModelDef(modelName: string, raw: unknown): LLMModelDef {
  return {
    modelName,
    ...parseSingleLLMConfig(raw),
  };
}

function hasObjectModels(raw: unknown): raw is { models: Record<string, unknown> } {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && !!(raw as any).models && typeof (raw as any).models === 'object' && !Array.isArray((raw as any).models);
}

export function parseLLMConfig(raw: unknown = {}): LLMRegistryConfig {
  if (hasObjectModels(raw)) {
    const source = raw;
    const models = Object.entries(source.models)
      .map(([modelName, value]) => ({ modelName: normalizeModelName(modelName), value }))
      .filter(({ modelName, value }) => !!modelName && value && typeof value === 'object' && !Array.isArray(value))
      .map(({ modelName, value }) => toModelDef(modelName!, value));

    if (models.length > 0) {
      const defaultModel = normalizeModelName((source as any).defaultModelName ?? (source as any).defaultModel);
      return {
        defaultModelName: defaultModel && models.some(model => model.modelName === defaultModel)
          ? defaultModel
          : models[0].modelName,
        models,
      };
    }
  }

  return {
    defaultModelName: DEFAULT_MODEL_NAME,
    models: [toModelDef(DEFAULT_MODEL_NAME, raw)],
  };
}
