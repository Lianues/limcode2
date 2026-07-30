/**
 * LLM 模型列表探测与格式转换
 */

import { DEFAULTS } from '../config/llm.js';
import type { LLMConfig } from '../config/types.js';

export type ModelListOutputFormat =
  | 'unified'
  | 'openai'
  | 'openai-compatible'
  | 'openai-responses'
  | 'deepseek'
  | 'claude'
  | 'gemini';

export type OpenAIModelListFormat = Extract<ModelListOutputFormat, 'openai' | 'openai-compatible' | 'openai-responses' | 'deepseek'>;

export interface ModelCatalogEntry {
  /**
   * 可直接传给调用接口的模型 ID。
   * Gemini 优先使用 baseModelId；没有 baseModelId 时使用去掉 models/ 前缀后的 name。
   */
  id: string;

  /**
   * Gemini 风格模型名称。Gemini 原生通常是 models/xxx；其它 provider 使用自身 id。
   */
  name: string;

  /** 展示名。上游没有 displayName/display_name 时回退为 id。 */
  displayName: string;

  /** 兼容旧版 UI 的展示标签，等价于 displayName/id 的组合。 */
  label?: string;

  /** Gemini 原生字段：基础模型 ID。只有上游提供或能明确映射时才返回。 */
  baseModelId?: string;
  /** Gemini 原生字段：版本。 */
  version?: string;
  /** Gemini 原生字段：描述。 */
  description?: string;
  /** Gemini 原生字段：输入 token 上限；Claude max_input_tokens 会映射到这里。 */
  inputTokenLimit?: number;
  /** Gemini 原生字段：输出 token 上限；Claude max_tokens 会映射到这里。 */
  outputTokenLimit?: number;
  /** Gemini 原生字段：支持的生成方法。 */
  supportedGenerationMethods?: string[];
  /** Gemini 原生字段：默认温度。 */
  temperature?: number;
  /** Gemini 原生字段：最大温度。 */
  maxTemperature?: number;
  /** Gemini 原生字段：topP。 */
  topP?: number;
  /** Gemini 原生字段：topK。 */
  topK?: number;

  /** 新增统一字段：模型归属方，对应 OpenAI owned_by 等。 */
  ownedBy?: string;
  /** 新增统一字段：创建时间 ISO 字符串，对应 Claude created_at；OpenAI created 会转换为 ISO。 */
  createdAt?: string;
  /** OpenAI 原生 Unix 秒时间戳；保留给转换回 OpenAI 格式使用。 */
  created?: number;
  /** 新增统一字段：模型对象类型，对应 OpenAI object / Claude type。 */
  modelType?: string;
  /** 新增统一字段：模型能力详情，主要对应 Claude capabilities。 */
  capabilities?: unknown;
  /** 上游原始模型对象。用于尽量保留 provider 私有字段和无损转换。 */
  raw?: unknown;
}

export interface ModelCatalogResult {
  provider: LLMConfig['provider'];
  baseUrl: string;
  models: ModelCatalogEntry[];
}

export interface OpenAIModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  [key: string]: unknown;
}

export interface OpenAIModelListResponse {
  object: 'list';
  data: OpenAIModelInfo[];
}

export interface GeminiModelInfo {
  name: string;
  baseModelId?: string;
  version?: string;
  displayName: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
  ownedBy?: string;
  createdAt?: string;
  modelType?: string;
  capabilities?: unknown;
  [key: string]: unknown;
}

export interface GeminiModelListResponse {
  models: GeminiModelInfo[];
  /** 已拉取完整列表，转换后的响应默认不再返回 nextPageToken。 */
  nextPageToken?: string;
}

export interface ClaudeModelInfo {
  id: string;
  type?: string;
  display_name?: string;
  created_at?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: unknown;
  [key: string]: unknown;
}

export interface ClaudeModelListResponse {
  data: ClaudeModelInfo[];
  /** 返回给下游的是完整列表，默认不暴露分页游标；如需要兼容字段，可自行在上层补 false。 */
  first_id?: string;
  last_id?: string;
  has_more?: false;
}

export type ModelListResponseFor<TFormat extends ModelListOutputFormat> =
  TFormat extends 'gemini' ? GeminiModelListResponse
    : TFormat extends 'claude' ? ClaudeModelListResponse
      : TFormat extends OpenAIModelListFormat ? OpenAIModelListResponse
        : ModelCatalogResult;

export interface ListAvailableModelsConfig extends Pick<LLMConfig, 'provider' | 'apiKey' | 'baseUrl' | 'fetch' | 'headers'> {
  /**
   * 返回格式。默认 unified（兼容旧版 listAvailableModels 的 { provider, baseUrl, models }）。
   */
  outputFormat?: ModelListOutputFormat;
  /** outputFormat 的别名，方便沿用包内其它 API 的 format 命名习惯。 */
  format?: ModelListOutputFormat;
  /** 分页大小。默认 1000，避免只拿到 provider 默认的 100 条。 */
  pageSize?: number;
}

const DEEPSEEK_MODELS: ModelCatalogEntry[] = [
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', displayName: 'deepseek-v4-flash', label: 'deepseek-v4-flash · Flash', ownedBy: 'deepseek', modelType: 'model' },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', displayName: 'deepseek-v4-pro', label: 'deepseek-v4-pro · Pro', ownedBy: 'deepseek', modelType: 'model' },
];

const DEFAULT_MODEL_LIST_PAGE_SIZE = 1000;
const MAX_MODEL_LIST_PAGES = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function omitUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as T;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asNonEmptyString(value);
    if (text) return text;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unixSecondsToISOString(value: unknown): string | undefined {
  const seconds = asNumber(value);
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(item => String(item).trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function stripModelsPrefix(value: string): string {
  return value.replace(/^models\//, '');
}

function toGeminiResourceName(idOrName: string): string {
  const value = idOrName.trim();
  return value.startsWith('models/') ? value : `models/${value}`;
}

function buildLabel(id: string, nameOrOwner?: string): string {
  const text = nameOrOwner?.trim();
  return text && text !== id ? `${id} · ${text}` : id;
}

function normalizePageSize(input?: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return DEFAULT_MODEL_LIST_PAGE_SIZE;
  return Math.max(1, Math.trunc(input));
}

function normalizeProviderForBaseUrl(provider: LLMConfig['provider']): keyof typeof DEFAULTS | 'openai' | string {
  return provider === 'openai' ? 'openai-compatible' : provider;
}

function normalizeBaseUrl(provider: LLMConfig['provider'], input?: string): string {
  const providerForDefaults = normalizeProviderForBaseUrl(provider);
  const fallback = DEFAULTS[providerForDefaults]?.baseUrl || '';
  let baseUrl = (input || fallback).trim();

  try {
    const url = new URL(baseUrl);
    url.search = '';
    url.hash = '';
    baseUrl = url.toString();
  } catch {
    baseUrl = baseUrl.split(/[?#]/, 1)[0];
  }

  baseUrl = baseUrl.replace(/\/+$/, '');

  switch (provider) {
    case 'gemini':
      baseUrl = baseUrl
        .replace(/\/models\/[^/?#]+:streamGenerateContent$/i, '')
        .replace(/\/models\/[^/?#]+:generateContent$/i, '')
        .replace(/\/models$/i, '');
      break;
    case 'openai':
    case 'openai-compatible':
    case 'openai-responses':
    case 'deepseek':
      baseUrl = baseUrl
        .replace(/\/chat\/completions$/i, '')
        .replace(/\/responses$/i, '')
        .replace(/\/models$/i, '');
      break;
    case 'claude':
      baseUrl = baseUrl
        .replace(/\/messages$/i, '')
        .replace(/\/models$/i, '');
      break;
  }

  return baseUrl.replace(/\/+$/, '');
}

function isOpenAIStyleProvider(provider: LLMConfig['provider']): boolean {
  return provider === 'openai'
    || provider === 'openai-compatible'
    || provider === 'openai-responses'
    || provider === 'deepseek';
}

function normalizeOutputFormat(format?: ModelListOutputFormat): ModelListOutputFormat {
  return format ?? 'unified';
}

function buildURL(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function dedupeModels(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Map<string, ModelCatalogEntry>();
  for (const entry of entries) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.set(id, {
      ...entry,
      id,
      label: entry.label?.trim() || id,
    });
  }
  return [...seen.values()];
}

async function parseErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `HTTP ${res.status}`;
  try {
    const body = JSON.parse(text);
    if (typeof body?.error === 'string') return body.error;
    if (typeof body?.error?.message === 'string') return body.error.message;
    if (typeof body?.message === 'string') return body.message;
    return text;
  } catch {
    return text;
  }
}

async function requestJSON(url: string, headers: Record<string, string>, fetchImpl?: typeof fetch): Promise<any> {
  const res = await (fetchImpl ?? fetch)(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }

  return res.json();
}

function parseGeminiModels(body: any): ModelCatalogEntry[] {
  const items = Array.isArray(body?.models) ? body.models : [];
  return items.map((item: any) => {
    const rawName = firstNonEmptyString(item?.name, item?.id);
    const nameWithoutPrefix = rawName ? stripModelsPrefix(rawName) : undefined;
    // Gemini native 响应常同时返回 name=models/xxx 和 baseModelId；对外可调用 ID 优先使用 baseModelId。
    const id = firstNonEmptyString(item?.baseModelId, nameWithoutPrefix, item?.id) ?? '';
    const displayName = firstNonEmptyString(item?.displayName, id) ?? id;
    const name = rawName ? toGeminiResourceName(rawName) : (id ? toGeminiResourceName(id) : id);
    return omitUndefined({
      id,
      name,
      displayName,
      label: buildLabel(id, displayName),
      baseModelId: firstNonEmptyString(item?.baseModelId),
      version: firstNonEmptyString(item?.version),
      description: firstNonEmptyString(item?.description),
      inputTokenLimit: asNumber(item?.inputTokenLimit),
      outputTokenLimit: asNumber(item?.outputTokenLimit),
      supportedGenerationMethods: asStringArray(item?.supportedGenerationMethods),
      temperature: asNumber(item?.temperature),
      maxTemperature: asNumber(item?.maxTemperature),
      topP: asNumber(item?.topP),
      topK: asNumber(item?.topK),
      raw: item,
    });
  });
}

function parseOpenAIStyleModels(body: any): ModelCatalogEntry[] {
  const items = Array.isArray(body?.data) ? body.data : [];
  return items.map((item: any) => {
    const id = firstNonEmptyString(item?.id, item?.name) ?? '';
    const owner = firstNonEmptyString(item?.owned_by, item?.owner);
    const displayName = firstNonEmptyString(item?.display_name, item?.displayName, item?.name, id) ?? id;
    const created = asNumber(item?.created);
    return omitUndefined({
      id,
      name: id,
      displayName,
      label: buildLabel(id, displayName !== id ? displayName : owner),
      modelType: firstNonEmptyString(item?.object, item?.type),
      ownedBy: owner,
      created,
      createdAt: firstNonEmptyString(item?.created_at) ?? unixSecondsToISOString(created),
      raw: item,
    });
  });
}

function parseClaudeModels(body: any): ModelCatalogEntry[] {
  const items = Array.isArray(body?.data) ? body.data : [];
  return items.map((item: any) => {
    const id = firstNonEmptyString(item?.id, item?.name) ?? '';
    const displayName = firstNonEmptyString(item?.display_name, item?.displayName, id) ?? id;
    return omitUndefined({
      id,
      name: id,
      displayName,
      label: buildLabel(id, displayName),
      modelType: firstNonEmptyString(item?.type),
      createdAt: firstNonEmptyString(item?.created_at),
      inputTokenLimit: asNumber(item?.max_input_tokens),
      outputTokenLimit: asNumber(item?.max_tokens),
      capabilities: isPlainObject(item?.capabilities) ? item.capabilities : undefined,
      raw: item,
    });
  });
}

async function fetchGeminiModelEntries(config: ListAvailableModelsConfig, baseUrl: string, pageSize: number): Promise<ModelCatalogEntry[]> {
  const apiKey = config.apiKey?.trim() || '';
  let pageToken: string | undefined;
  const entries: ModelCatalogEntry[] = [];

  for (let page = 0; page < MAX_MODEL_LIST_PAGES; page++) {
    const body = await requestJSON(buildURL(baseUrl, '/models', {
      key: apiKey,
      pageSize,
      pageToken,
    }), {
      ...config.headers,
    }, config.fetch);

    entries.push(...parseGeminiModels(body));
    pageToken = firstNonEmptyString(body?.nextPageToken);
    if (!pageToken) return dedupeModels(entries);
  }

  throw new Error('模型列表分页过多，已停止继续拉取');
}

async function fetchOpenAIStyleModelEntries(config: ListAvailableModelsConfig, baseUrl: string, pageSize: number): Promise<ModelCatalogEntry[]> {
  const apiKey = config.apiKey?.trim() || '';
  let after: string | undefined;
  const entries: ModelCatalogEntry[] = [];

  for (let page = 0; page < MAX_MODEL_LIST_PAGES; page++) {
    const body = await requestJSON(buildURL(baseUrl, '/models', {
      limit: pageSize,
      after,
    }), {
      Authorization: `Bearer ${apiKey}`,
      ...config.headers,
    }, config.fetch);

    entries.push(...parseOpenAIStyleModels(body));

    const hasMore = body?.has_more === true;
    const nextAfter = firstNonEmptyString(body?.last_id, body?.next_page_token, body?.nextPageToken);
    if (!hasMore) return dedupeModels(entries);
    if (!nextAfter) {
      throw new Error('模型列表响应声明还有更多页面，但没有返回可继续分页的游标');
    }
    after = nextAfter;
  }

  throw new Error('模型列表分页过多，已停止继续拉取');
}

async function fetchClaudeModelEntries(config: ListAvailableModelsConfig, baseUrl: string, pageSize: number): Promise<ModelCatalogEntry[]> {
  const apiKey = config.apiKey?.trim() || '';
  let afterId: string | undefined;
  const entries: ModelCatalogEntry[] = [];

  for (let page = 0; page < MAX_MODEL_LIST_PAGES; page++) {
    const body = await requestJSON(buildURL(baseUrl, '/models', {
      limit: pageSize,
      after_id: afterId,
    }), {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...config.headers,
    }, config.fetch);

    entries.push(...parseClaudeModels(body));

    const hasMore = body?.has_more === true;
    const nextAfterId = firstNonEmptyString(body?.last_id);
    if (!hasMore) return dedupeModels(entries);
    if (!nextAfterId) {
      throw new Error('Claude 模型列表响应声明还有更多页面，但没有返回 last_id');
    }
    afterId = nextAfterId;
  }

  throw new Error('模型列表分页过多，已停止继续拉取');
}

function toUnifiedModelList(provider: LLMConfig['provider'], baseUrl: string, entries: ModelCatalogEntry[]): ModelCatalogResult {
  return {
    provider,
    baseUrl,
    models: entries,
  };
}

function toOpenAIModelList(entries: ModelCatalogEntry[]): OpenAIModelListResponse {
  return {
    object: 'list',
    data: entries.map(entry => {
      const raw = isPlainObject(entry.raw) ? { ...entry.raw } : {};
      const created = asNumber(raw.created) ?? entry.created;
      const ownedBy = firstNonEmptyString(raw.owned_by, entry.ownedBy);
      const object = firstNonEmptyString(raw.object, entry.modelType);
      return omitUndefined({
        ...raw,
        id: entry.id,
        object,
        ...(created !== undefined ? { created } : {}),
        ...(ownedBy ? { owned_by: ownedBy } : {}),
      });
    }),
  };
}

function toClaudeModelList(entries: ModelCatalogEntry[]): ClaudeModelListResponse {
  const data = entries.map(entry => {
    const raw = isPlainObject(entry.raw) ? { ...entry.raw } : {};
    const displayName = firstNonEmptyString(raw.display_name, raw.displayName, entry.displayName, entry.id) ?? entry.id;
    const createdAt = firstNonEmptyString(raw.created_at, entry.createdAt)
      ?? (entry.created ? new Date(entry.created * 1000).toISOString() : undefined);
    const maxInputTokens = asNumber(raw.max_input_tokens) ?? entry.inputTokenLimit;
    const maxTokens = asNumber(raw.max_tokens) ?? entry.outputTokenLimit;
    const capabilities = isPlainObject(raw.capabilities) ? raw.capabilities : entry.capabilities;
    const type = firstNonEmptyString(raw.type, entry.modelType);
    return omitUndefined({
      ...raw,
      id: entry.id,
      type,
      display_name: displayName,
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
    });
  });

  return { data };
}

function toGeminiModelList(entries: ModelCatalogEntry[]): GeminiModelListResponse {
  return {
    models: entries.map(entry => {
      const raw = isPlainObject(entry.raw) ? { ...entry.raw } : {};
      const name = firstNonEmptyString(raw.name, entry.name, entry.id) ?? entry.id;
      const displayName = firstNonEmptyString(raw.displayName, raw.display_name, entry.displayName, entry.id) ?? entry.id;
      const baseModelId = firstNonEmptyString(raw.baseModelId, entry.baseModelId);
      const supportedGenerationMethods = asStringArray(raw.supportedGenerationMethods)
        ?? entry.supportedGenerationMethods;
      const version = firstNonEmptyString(raw.version, entry.version);
      const description = firstNonEmptyString(raw.description, entry.description);
      const inputTokenLimit = asNumber(raw.inputTokenLimit) ?? asNumber(raw.max_input_tokens) ?? entry.inputTokenLimit;
      const outputTokenLimit = asNumber(raw.outputTokenLimit) ?? asNumber(raw.max_tokens) ?? entry.outputTokenLimit;
      const temperature = asNumber(raw.temperature) ?? entry.temperature;
      const maxTemperature = asNumber(raw.maxTemperature) ?? entry.maxTemperature;
      const topP = asNumber(raw.topP) ?? entry.topP;
      const topK = asNumber(raw.topK) ?? entry.topK;
      const ownedBy = firstNonEmptyString(raw.ownedBy, raw.owned_by, raw.owner, entry.ownedBy);
      const createdAt = firstNonEmptyString(raw.createdAt, raw.created_at, entry.createdAt) ?? unixSecondsToISOString(raw.created ?? entry.created);
      const modelType = firstNonEmptyString(raw.modelType, raw.type, raw.object, entry.modelType);
      const capabilities = isPlainObject(raw.capabilities) ? raw.capabilities : entry.capabilities;
      return omitUndefined({
        ...raw,
        name: toGeminiResourceName(name),
        ...(baseModelId ? { baseModelId } : {}),
        ...(version ? { version } : {}),
        displayName,
        ...(description ? { description } : {}),
        ...(inputTokenLimit !== undefined ? { inputTokenLimit } : {}),
        ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
        ...(supportedGenerationMethods ? { supportedGenerationMethods } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTemperature !== undefined ? { maxTemperature } : {}),
        ...(topP !== undefined ? { topP } : {}),
        ...(topK !== undefined ? { topK } : {}),
        ...(ownedBy ? { ownedBy } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(modelType ? { modelType } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
      });
    }),
  };
}

function convertModelList<TFormat extends ModelListOutputFormat>(
  provider: LLMConfig['provider'],
  baseUrl: string,
  entries: ModelCatalogEntry[],
  outputFormat: TFormat,
): ModelListResponseFor<TFormat> {
  switch (outputFormat) {
    case 'gemini':
      return toGeminiModelList(entries) as ModelListResponseFor<TFormat>;
    case 'claude':
      return toClaudeModelList(entries) as ModelListResponseFor<TFormat>;
    case 'openai':
    case 'openai-compatible':
    case 'openai-responses':
    case 'deepseek':
      return toOpenAIModelList(entries) as ModelListResponseFor<TFormat>;
    case 'unified':
    default:
      return toUnifiedModelList(provider, baseUrl, entries) as ModelListResponseFor<TFormat>;
  }
}

export async function listAvailableModels<TFormat extends ModelListOutputFormat = 'unified'>(
  config: ListAvailableModelsConfig & { outputFormat?: TFormat; format?: TFormat },
): Promise<ModelListResponseFor<TFormat>> {
  const provider = config.provider;
  const apiKey = config.apiKey?.trim() || '';
  const baseUrl = normalizeBaseUrl(provider, config.baseUrl);
  const pageSize = normalizePageSize(config.pageSize);
  const outputFormat = normalizeOutputFormat(config.outputFormat ?? config.format) as TFormat;

  if (provider === 'deepseek' && !apiKey) {
    return convertModelList(provider, baseUrl, dedupeModels(DEEPSEEK_MODELS), outputFormat);
  }

  if (!apiKey) {
    throw new Error('缺少 API Key');
  }
  if (!baseUrl) {
    throw new Error('缺少 API 地址');
  }

  let entries: ModelCatalogEntry[];
  if (provider === 'gemini') {
    entries = await fetchGeminiModelEntries(config, baseUrl, pageSize);
  } else if (provider === 'claude') {
    entries = await fetchClaudeModelEntries(config, baseUrl, pageSize);
  } else if (isOpenAIStyleProvider(provider)) {
    entries = await fetchOpenAIStyleModelEntries(config, baseUrl, pageSize);
  } else {
    throw new Error(`暂不支持提供商 ${provider} 的模型列表拉取`);
  }

  return convertModelList(provider, baseUrl, entries, outputFormat);
}
