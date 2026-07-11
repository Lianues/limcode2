import * as vscode from 'vscode';
import type {
  LlmCompressionConfigRecord,
  LlmCompressionConfigsRecord,
  LlmCompressionFallbackMode,
  LlmCompressionMethodKind,
  LlmCompressionSettingsRecord,
  LlmCompressionThresholdUnit,
  LlmCompressionTriggerMode
} from '../../../shared/protocol';
import { DEFAULT_LLM_COMPRESSION_RESERVE_TOKENS, DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT, createDefaultLlmCompressionConfig } from '../../../shared/protocol';
import type { StoragePaths } from './clientStateStore';
import { INDEX_FILE } from './constants';
import { loadRecordStore, removeRecordStoreRecord, saveRecordStore } from './recordStore';

const RECORD_KEY = 'config';
const CONFIGS_DIR = 'llm-compression-configs';
const DEFAULT_CONFIG_NAME = '默认压缩方法';

export async function loadLlmCompressionConfigsSettings(paths: StoragePaths): Promise<{ settings: LlmCompressionConfigsRecord; filePath: string }> {
  const records = await loadRawLlmCompressionConfigRecords(paths);
  if (records.length > 0) {
    return { settings: { configs: sortConfigs(records.map((record) => normalizeLlmCompressionConfig(record))) }, filePath: configsIndexUri(paths).fsPath };
  }

  const config = normalizeLlmCompressionConfig(createDefaultLlmCompressionConfig(DEFAULT_CONFIG_NAME));
  await writeLlmCompressionConfigRecords(paths, [config]);
  return { settings: { configs: [config] }, filePath: configsIndexUri(paths).fsPath };
}

export async function saveLlmCompressionConfigsSettings(
  paths: StoragePaths,
  settings: Partial<LlmCompressionConfigsRecord> | undefined
): Promise<{ settings: LlmCompressionConfigsRecord; filePath: string }> {
  const previous = await loadLlmCompressionConfigsSettings(paths);
  const configs = normalizeConfigList(settings?.configs);
  if (configs.length === 0) throw new Error('至少需要保留一个压缩方法配置。');

  const nextIds = new Set(configs.map((config) => config.id));
  for (const previousConfig of previous.settings.configs) {
    if (!nextIds.has(previousConfig.id)) {
      await removeRecordStoreRecord(configsRootUri(paths), configsIndexUri(paths), previousConfig.id, RECORD_KEY);
    }
  }

  await writeLlmCompressionConfigRecords(paths, configs);
  return loadLlmCompressionConfigsSettings(paths);
}

export function normalizeLlmCompressionSettings(input: Partial<LlmCompressionSettingsRecord> | undefined, configs: LlmCompressionConfigRecord[] = []): LlmCompressionSettingsRecord {
  const configIds = new Set(configs.map((config) => config.id));
  const defaultConfigId = typeof input?.defaultConfigId === 'string' && (!configIds.size || configIds.has(input.defaultConfigId))
    ? input.defaultConfigId
    : configs[0]?.id;
  const providerBindings = (Array.isArray(input?.providerBindings) ? input.providerBindings : [])
    .map((binding) => {
      const providerConfigId = typeof binding?.providerConfigId === 'string' ? binding.providerConfigId.trim() : '';
      const compressionConfigId = typeof binding?.compressionConfigId === 'string' ? binding.compressionConfigId.trim() : '';
      if (!providerConfigId || !compressionConfigId || (configIds.size > 0 && !configIds.has(compressionConfigId))) return undefined;
      const createdAt = finiteTimestamp(binding.createdAt, Date.now());
      return {
        id: typeof binding.id === 'string' && binding.id.trim() ? binding.id.trim() : `llm-compression-binding-${providerConfigId}`,
        providerConfigId,
        compressionConfigId,
        role: 'default' as const,
        createdAt,
        updatedAt: finiteTimestamp(binding.updatedAt, createdAt)
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  const modelBindings = (Array.isArray(input?.modelBindings) ? input.modelBindings : [])
    .map((binding) => {
      const providerConfigId = typeof binding?.providerConfigId === 'string' ? binding.providerConfigId.trim() : '';
      const modelId = typeof binding?.modelId === 'string' ? binding.modelId.trim() : '';
      const compressionConfigId = typeof binding?.compressionConfigId === 'string' ? binding.compressionConfigId.trim() : '';
      if (!providerConfigId || !modelId || !compressionConfigId || (configIds.size > 0 && !configIds.has(compressionConfigId))) return undefined;
      const createdAt = finiteTimestamp(binding.createdAt, Date.now());
      return {
        id: typeof binding.id === 'string' && binding.id.trim() ? binding.id.trim() : `llm-compression-model-binding-${providerConfigId}-${safeId(modelId)}`,
        providerConfigId,
        modelId,
        compressionConfigId,
        role: 'model' as const,
        createdAt,
        updatedAt: finiteTimestamp(binding.updatedAt, createdAt)
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  return { ...(defaultConfigId ? { defaultConfigId } : {}), providerBindings, modelBindings };
}

export function normalizeLlmCompressionConfig(input: Partial<LlmCompressionConfigRecord> | undefined): LlmCompressionConfigRecord {
  const fallback = createDefaultLlmCompressionConfig(DEFAULT_CONFIG_NAME);
  const createdAt = finiteTimestamp(input?.createdAt, fallback.createdAt);
  const kind = isKnownKind(input?.kind) ? input.kind : fallback.kind;
  const trigger = normalizeTrigger(input?.trigger);
  const fallbackPolicy = normalizeFallbackPolicy(input?.fallbackPolicy);
  return {
    id: stringOrDefault(input?.id, fallback.id),
    name: stringOrDefault(input?.name, fallback.name),
    kind,
    trigger,
    ...(normalizeOpenAICompact(input?.openaiResponsesCompact) ? { openaiResponsesCompact: normalizeOpenAICompact(input?.openaiResponsesCompact) } : {}),
    ...(normalizeLlmSummary(input?.llmSummary) ? { llmSummary: normalizeLlmSummary(input?.llmSummary) } : {}),
    fallbackPolicy,
    createdAt,
    updatedAt: finiteTimestamp(input?.updatedAt, createdAt)
  };
}

function normalizeConfigList(input: LlmCompressionConfigRecord[] | undefined): LlmCompressionConfigRecord[] {
  const byId = new Map<string, LlmCompressionConfigRecord>();
  for (const item of input ?? []) byId.set(item.id, normalizeLlmCompressionConfig({ ...item, updatedAt: Date.now() }));
  return sortConfigs([...byId.values()]);
}

async function loadRawLlmCompressionConfigRecords(paths: StoragePaths): Promise<LlmCompressionConfigRecord[]> {
  return (await loadRecordStore<LlmCompressionConfigRecord, typeof RECORD_KEY>(configsRootUri(paths), configsIndexUri(paths), RECORD_KEY)) ?? [];
}

async function writeLlmCompressionConfigRecords(paths: StoragePaths, records: LlmCompressionConfigRecord[]): Promise<void> {
  await saveRecordStore(configsRootUri(paths), configsIndexUri(paths), sortConfigs(records.map(normalizeLlmCompressionConfig)), RECORD_KEY, (record) => record.name);
}

function configsRootUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.settingsRootUri, CONFIGS_DIR);
}

function configsIndexUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(configsRootUri(paths), INDEX_FILE);
}

function sortConfigs(records: LlmCompressionConfigRecord[]): LlmCompressionConfigRecord[] {
  return [...records].sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function normalizeTrigger(input: unknown): LlmCompressionConfigRecord['trigger'] {
  const record = isPlainObject(input) ? input : {};
  const thresholdUnit: LlmCompressionThresholdUnit = isKnownThresholdUnit(record.thresholdUnit) ? record.thresholdUnit : 'percent';
  const thresholdTokens = finitePositiveNumber(record.thresholdTokens);
  const inputThresholdPercent = finitePercent(record.thresholdPercent);
  const preserveLatestMessages = finitePositiveNumber(record.preserveLatestMessages);
  const inputReserveLatestUserMessageTokens = finitePositiveNumber(record.reserveLatestUserMessageTokens);
  const hasExplicitTriggerChoice = isKnownThresholdUnit(record.thresholdUnit) || inputThresholdPercent !== undefined || thresholdTokens !== undefined || inputReserveLatestUserMessageTokens !== undefined;
  const mode: LlmCompressionTriggerMode = record.mode === 'manual' && hasExplicitTriggerChoice ? 'manual' : 'token_threshold';
  const thresholdPercent = inputThresholdPercent ?? DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT;
  const reserveLatestUserMessageTokens = inputReserveLatestUserMessageTokens ?? DEFAULT_LLM_COMPRESSION_RESERVE_TOKENS;
  return {
    mode,
    thresholdUnit,
    thresholdPercent,
    ...(thresholdTokens !== undefined ? { thresholdTokens } : {}),
    ...(preserveLatestMessages !== undefined ? { preserveLatestMessages } : {}),
    reserveLatestUserMessageTokens
  };
}

function normalizeFallbackPolicy(input: unknown): LlmCompressionConfigRecord['fallbackPolicy'] {
  const record = isPlainObject(input) ? input : {};
  const fallback: LlmCompressionFallbackMode = isKnownFallbackMode(record.whenNativeUnavailable) ? record.whenNativeUnavailable : 'use_summary';
  return { whenNativeUnavailable: fallback };
}

function normalizeOpenAICompact(input: unknown): LlmCompressionConfigRecord['openaiResponsesCompact'] | undefined {
  if (!isPlainObject(input)) return undefined;
  return {
    ...(optionalString(input.providerConfigId) ? { providerConfigId: optionalString(input.providerConfigId) } : {}),
    ...(optionalString(input.model) ? { model: optionalString(input.model) } : {}),
    ...(typeof input.createSummaryFallback === 'boolean' ? { createSummaryFallback: input.createSummaryFallback } : {}),
    ...(optionalString(input.fallbackConfigId) ? { fallbackConfigId: optionalString(input.fallbackConfigId) } : {})
  };
}

function normalizeLlmSummary(input: unknown): LlmCompressionConfigRecord['llmSummary'] | undefined {
  if (!isPlainObject(input)) return undefined;
  return {
    ...(optionalString(input.providerConfigId) ? { providerConfigId: optionalString(input.providerConfigId) } : {}),
    ...(optionalString(input.model) ? { model: optionalString(input.model) } : {}),
    ...(optionalString(input.systemPrompt) ? { systemPrompt: optionalString(input.systemPrompt) } : {}),
    ...(optionalString(input.userPrompt) ? { userPrompt: optionalString(input.userPrompt) } : {}),
    ...(finitePositiveNumber(input.targetTokens) ? { targetTokens: finitePositiveNumber(input.targetTokens) } : {}),
    ...(isPlainObject(input.generationConfig) ? { generationConfig: input.generationConfig } : {})
  };
}

function isKnownKind(value: unknown): value is LlmCompressionMethodKind {
  return value === 'disabled' || value === 'openai_responses_compact' || value === 'llm_summary' || value === 'segmented_summary' || value === 'deterministic_summary' || value === 'manual_summary';
}

function isKnownFallbackMode(value: unknown): value is LlmCompressionFallbackMode {
  return value === 'use_summary' || value === 'use_raw_history' || value === 'block_and_ask' || value === 'auto_generate_summary';
}

function isKnownThresholdUnit(value: unknown): value is LlmCompressionThresholdUnit {
  return value === 'percent' || value === 'tokens';
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
}

function finiteTimestamp(value: unknown, fallback: number): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function finitePositiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function finitePercent(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(100, Math.max(1, number));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
