import * as vscode from 'vscode';
import type {
  LlmGenerationConfigRecord,
  LlmProviderConfigRecord,
  LlmProviderConfigsRecord,
  LlmProviderHeadersRecord,
  LlmProviderKind,
  LlmProviderModelRecord,
  LlmRequestBodyJsonValue,
  LlmRequestBodyRecord,
  LlmThinkingConfigRecord,
  LlmThinkingLevel,
  LlmToolCallFormat
} from '../../../shared/protocol';
import {
  DEFAULT_LLM_CONTEXT_WINDOW_TOKENS,
  DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
  DEFAULT_LLM_RETRY_ON_ERROR,
  createMessageId
} from '../../../shared/protocol';
import { DEFAULT_LLM_BASE_URL } from '../llmProvider';
import type { StoragePaths } from './clientStateStore';
import { INDEX_FILE } from './constants';
import { loadRecordStore, removeRecordStoreRecord, saveRecordStore } from './recordStore';

const RECORD_KEY = 'config';
const CONFIGS_DIR = 'llm-provider-configs';
const DEFAULT_CONFIG_NAME = '默认渠道';

export async function loadLlmProviderConfigsSettings(paths: StoragePaths): Promise<{ settings: LlmProviderConfigsRecord; filePath: string }> {
  const records = await loadRawLlmProviderConfigRecords(paths);
  if (records.length > 0) {
    return { settings: { configs: sortConfigs(records.map((record) => normalizeLlmProviderConfig(record))) }, filePath: configsIndexUri(paths).fsPath };
  }

  const config = createDefaultLlmProviderConfig({ name: DEFAULT_CONFIG_NAME });
  await writeLlmProviderConfigRecords(paths, [config]);
  return { settings: { configs: [config] }, filePath: configsIndexUri(paths).fsPath };
}

export async function saveLlmProviderConfigsSettings(
  paths: StoragePaths,
  settings: Partial<LlmProviderConfigsRecord> | undefined
): Promise<{ settings: LlmProviderConfigsRecord; filePath: string }> {
  const previous = await loadLlmProviderConfigsSettings(paths);
  const configs = normalizeConfigList(settings?.configs);
  if (configs.length === 0) {
    throw new Error('至少需要保留一个渠道配置。');
  }

  const nextIds = new Set(configs.map((config) => config.id));
  for (const previousConfig of previous.settings.configs) {
    if (!nextIds.has(previousConfig.id)) {
      await removeRecordStoreRecord(configsRootUri(paths), configsIndexUri(paths), previousConfig.id);
    }
  }

  await writeLlmProviderConfigRecords(paths, configs);
  return loadLlmProviderConfigsSettings(paths);
}

export function createDefaultLlmProviderConfig(input: { name?: string } = {}): LlmProviderConfigRecord {
  const now = Date.now();
  return {
    id: createConfigId(),
    name: input.name?.trim() || DEFAULT_CONFIG_NAME,
    provider: 'openai-compatible',
    baseUrl: DEFAULT_LLM_BASE_URL,
    model: '',
    models: [],
    apiKey: '',
    toolCallFormat: 'function-call',
    stream: true,
    retryOnError: DEFAULT_LLM_RETRY_ON_ERROR,
    retryMaxAttempts: DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    contextWindowTokens: DEFAULT_LLM_CONTEXT_WINDOW_TOKENS,
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeLlmProviderConfig(input: Partial<LlmProviderConfigRecord> | undefined): LlmProviderConfigRecord {
  const fallback = createDefaultLlmProviderConfig();
  const createdAt = finiteTimestamp(input?.createdAt, fallback.createdAt);
  const updatedAt = finiteTimestamp(input?.updatedAt, createdAt);
  const model = typeof input?.model === 'string' && input.model.trim() ? input.model.trim() : fallback.model;
  const models = normalizeProviderModels(input?.models, model);
  const headers = normalizeHeaders(input?.headers);
  const generationConfig = normalizeGenerationConfig(input?.generationConfig);
  const requestBody = normalizeRequestBody(input?.requestBody);
  const provider = isKnownProvider(input?.provider) ? input.provider : fallback.provider;
  const contextWindowTokens = finitePositiveInteger(input?.contextWindowTokens) ?? providerDefaultContextWindow(provider);
  return {
    id: stringOrDefault(input?.id, fallback.id),
    name: stringOrDefault(input?.name, fallback.name),
    provider,
    baseUrl: stringOrDefault(input?.baseUrl, fallback.baseUrl),
    model,
    models,
    apiKey: typeof input?.apiKey === 'string' ? input.apiKey.trim() : fallback.apiKey,
    toolCallFormat: isKnownToolCallFormat(input?.toolCallFormat) ? input.toolCallFormat : fallback.toolCallFormat,
    stream: typeof input?.stream === 'boolean' ? input.stream : true,
    retryOnError: typeof input?.retryOnError === 'boolean' ? input.retryOnError : DEFAULT_LLM_RETRY_ON_ERROR,
    retryMaxAttempts: finiteRetryMaxAttempts(input?.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    contextWindowTokens,
    ...(headers ? { headers } : {}),
    ...(generationConfig ? { generationConfig } : {}),
    ...(requestBody ? { requestBody } : {}),
    createdAt,
    updatedAt
  };
}

function normalizeConfigList(input: LlmProviderConfigRecord[] | undefined): LlmProviderConfigRecord[] {
  const byId = new Map<string, LlmProviderConfigRecord>();
  for (const item of input ?? []) {
    const config = normalizeLlmProviderConfig({ ...item, updatedAt: Date.now() });
    byId.set(config.id, config);
  }
  return sortConfigs([...byId.values()]);
}

async function loadRawLlmProviderConfigRecords(paths: StoragePaths): Promise<LlmProviderConfigRecord[]> {
  const records = await loadRecordStore<LlmProviderConfigRecord, typeof RECORD_KEY>(
    configsRootUri(paths),
    configsIndexUri(paths),
    RECORD_KEY
  );
  return records ?? [];
}

async function writeLlmProviderConfigRecords(paths: StoragePaths, records: LlmProviderConfigRecord[]): Promise<void> {
  await saveRecordStore(
    configsRootUri(paths),
    configsIndexUri(paths),
    sortConfigs(records.map((record) => normalizeLlmProviderConfig(record))),
    RECORD_KEY,
    (record) => record.name
  );
}

function configsRootUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.settingsRootUri, CONFIGS_DIR);
}

function configsIndexUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(configsRootUri(paths), INDEX_FILE);
}

function createConfigId(): string {
  return `llm-provider-config-${createMessageId()}`;
}

function sortConfigs(records: LlmProviderConfigRecord[]): LlmProviderConfigRecord[] {
  return [...records].sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function normalizeProviderModels(input: LlmProviderModelRecord[] | undefined, activeModel: string): LlmProviderModelRecord[] {
  const byId = new Map<string, LlmProviderModelRecord>();
  for (const item of input ?? []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
    const createdAt = typeof item.createdAt === 'string' && item.createdAt.trim() ? item.createdAt.trim() : undefined;
    byId.set(id, { id, name, ...(createdAt ? { createdAt } : {}) });
  }

  if (activeModel && !byId.has(activeModel)) {
    byId.set(activeModel, { id: activeModel, name: activeModel });
  }

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function isKnownProvider(provider: unknown): provider is LlmProviderKind {
  return provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'claude' || provider === 'gemini' || provider === 'deepseek';
}

function providerDefaultContextWindow(_provider: LlmProviderKind): number {
  return DEFAULT_LLM_CONTEXT_WINDOW_TOKENS;
}

function isKnownToolCallFormat(format: unknown): format is LlmToolCallFormat {
  return format === 'function-call';
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
function finiteTimestamp(value: unknown, fallback: number): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function finitePositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function finiteRetryMaxAttempts(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const attempts = Math.floor(number);
  return attempts < -1 ? -1 : attempts;
}

function normalizeHeaders(input: unknown): LlmProviderHeadersRecord | undefined {
  if (!isPlainObject(input)) return undefined;
  const headers: LlmProviderHeadersRecord = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue;
    headers[key] = String(rawValue).trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeGenerationConfig(input: unknown): LlmGenerationConfigRecord | undefined {
  if (!isPlainObject(input)) return undefined;
  const config: LlmGenerationConfigRecord = {};
  assignFiniteNumber(config, 'temperature', input.temperature);
  assignFiniteNumber(config, 'topP', input.topP);
  assignFiniteNumber(config, 'topK', input.topK);
  assignFiniteNumber(config, 'maxOutputTokens', input.maxOutputTokens);

  const thinkingConfig = normalizeThinkingConfig(input.thinkingConfig);
  if (thinkingConfig) config.thinkingConfig = thinkingConfig;

  return Object.keys(config).length > 0 ? config : undefined;
}

function normalizeThinkingConfig(input: unknown): LlmThinkingConfigRecord | undefined {
  if (!isPlainObject(input)) return undefined;
  const config: LlmThinkingConfigRecord = {};
  if (typeof input.includeThoughts === 'boolean') config.includeThoughts = input.includeThoughts;
  assignFiniteNumber(config, 'thinkingBudget', input.thinkingBudget);
  if (isKnownThinkingLevel(input.thinkingLevel)) config.thinkingLevel = input.thinkingLevel;
  return Object.keys(config).length > 0 ? config : undefined;
}

function assignFiniteNumber(target: object, key: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  (target as Record<string, unknown>)[key] = value;
}

function isKnownThinkingLevel(value: unknown): value is LlmThinkingLevel {
  return value === 'not-set'
    || value === 'non-set'
    || value === 'none'
    || value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max';
}

function normalizeRequestBody(input: unknown): LlmRequestBodyRecord | undefined {
  if (!isPlainObject(input)) return undefined;
  const record: LlmRequestBodyRecord = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    const value = normalizeJsonValue(rawValue);
    if (value !== undefined) record[key] = value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function normalizeJsonValue(value: unknown): LlmRequestBodyJsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: LlmRequestBodyJsonValue[] = [];
    for (const item of value) {
      const normalized = normalizeJsonValue(item);
      if (normalized !== undefined) items.push(normalized);
    }
    return items;
  }
  if (isPlainObject(value)) {
    const record: Record<string, LlmRequestBodyJsonValue> = {};
    for (const [rawKey, rawChild] of Object.entries(value)) {
      const key = rawKey.trim();
      if (!key) continue;
      const child = normalizeJsonValue(rawChild);
      if (child !== undefined) record[key] = child;
    }
    return record;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
