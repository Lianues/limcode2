import * as vscode from 'vscode';
import type { LlmProviderConfigRecord, LlmProviderConfigsRecord, LlmProviderKind, LlmToolCallFormat } from '../../../shared/protocol';
import { createMessageId } from '../../../shared/protocol';
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from '../llmProvider';
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
    provider: 'deepseek',
    baseUrl: DEFAULT_LLM_BASE_URL,
    model: DEFAULT_LLM_MODEL,
    apiKey: '',
    toolCallFormat: 'function-call',
    temperature: 0.2,
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeLlmProviderConfig(input: Partial<LlmProviderConfigRecord> | undefined): LlmProviderConfigRecord {
  const fallback = createDefaultLlmProviderConfig();
  const createdAt = finiteTimestamp(input?.createdAt, fallback.createdAt);
  const updatedAt = finiteTimestamp(input?.updatedAt, createdAt);
  const temperature = Number(input?.temperature ?? fallback.temperature);
  return {
    id: stringOrDefault(input?.id, fallback.id),
    name: stringOrDefault(input?.name, fallback.name),
    provider: isKnownProvider(input?.provider) ? input.provider : fallback.provider,
    baseUrl: stringOrDefault(input?.baseUrl, fallback.baseUrl),
    model: stringOrDefault(input?.model, fallback.model),
    apiKey: typeof input?.apiKey === 'string' ? input.apiKey.trim() : fallback.apiKey,
    toolCallFormat: isKnownToolCallFormat(input?.toolCallFormat) ? input.toolCallFormat : fallback.toolCallFormat,
    ...(optionalString(input?.proxy) ? { proxy: optionalString(input?.proxy) } : {}),
    temperature: Number.isFinite(temperature) ? temperature : fallback.temperature,
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

function isKnownProvider(provider: unknown): provider is LlmProviderKind {
  return provider === 'deepseek' || provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'claude' || provider === 'gemini';
}

function isKnownToolCallFormat(format: unknown): format is LlmToolCallFormat {
  return format === 'function-call';
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function finiteTimestamp(value: unknown, fallback: number): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}
