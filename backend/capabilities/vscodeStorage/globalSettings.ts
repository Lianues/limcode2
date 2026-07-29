import * as vscode from 'vscode';
import type {
  AttachmentSettingsRecord,
  AppearanceSettingsRecord,
  CheckpointMaintenanceSettingsRecord,
  GlobalSettingsSection,
  GlobalSettingsSectionValue,
  LlmCompressionSettingsRecord,
  LlmSettingsRecord,
  RunHistorySettingsRecord
} from '../../../shared/protocol';
import { createDefaultLlmCompressionSettings } from '../../../shared/protocol';
import {
  APPEARANCE_SETTINGS_FILE,
  ATTACHMENT_SETTINGS_FILE,
  CHECKPOINT_MAINTENANCE_SETTINGS_FILE,
  LLM_COMPRESSION_SETTINGS_FILE,
  LLM_SETTINGS_FILE,
  RUN_HISTORY_SETTINGS_FILE,
  STORAGE_VERSION
} from './constants';
import { SettingsRevisionConflictError } from '../settingsRevisionConflict';
import { readJsonStrict, writeJson, type StrictJsonReadResult } from './json';
import { createDefaultLlmSettings, normalizeLlmSettings } from './llmSettings';
import { normalizeLlmCompressionSettings } from './llmCompressionConfigs';
import { withStorageResourceLock } from './storageResourceLock';
import { createMissingStorageRevision, createStorageRevision } from './storageRevision';

interface GlobalSettingsFile<T> {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  settings: T;
}

export interface GlobalSettingsFileResult {
  section: GlobalSettingsSection;
  settings: GlobalSettingsSectionValue;
  filePath: string;
  /** 规范化设置内容的 opaque revision；与 savedAt 解耦，任意语义变化都会改变。 */
  revision: string;
  /** 仅提交结果携带：CAS 比对所针对的前一份一致快照。 */
  previousSettings?: GlobalSettingsSectionValue;
}

type FileBackedGlobalSettingsSection = Exclude<GlobalSettingsSection, 'common' | 'llmProviderConfigs' | 'llmCompressionConfigs' | 'mcpServers'>;

const GLOBAL_SETTINGS_SECTION_SPECS: Record<FileBackedGlobalSettingsSection, {
  fileName: string;
  createDefault: () => GlobalSettingsSectionValue;
  normalize: (input: Partial<GlobalSettingsSectionValue> | undefined) => GlobalSettingsSectionValue;
}> = {
  llm: {
    fileName: LLM_SETTINGS_FILE,
    createDefault: createDefaultLlmSettings,
    normalize: (input) => normalizeLlmSettings(input as Partial<LlmSettingsRecord> | undefined)
  },
  llmCompression: {
    fileName: LLM_COMPRESSION_SETTINGS_FILE,
    createDefault: createDefaultLlmCompressionSettings,
    normalize: (input) => normalizeLlmCompressionSettings(input as Partial<LlmCompressionSettingsRecord> | undefined)
  },
  checkpointMaintenance: {
    fileName: CHECKPOINT_MAINTENANCE_SETTINGS_FILE,
    createDefault: createDefaultCheckpointMaintenanceSettings,
    normalize: (input) => normalizeCheckpointMaintenanceSettings(input as Partial<CheckpointMaintenanceSettingsRecord> | undefined)
  },
  appearance: {
    fileName: APPEARANCE_SETTINGS_FILE,
    createDefault: createDefaultAppearanceSettings,
    normalize: (input) => normalizeAppearanceSettings(input as Partial<AppearanceSettingsRecord> | undefined)
  },
  attachments: {
    fileName: ATTACHMENT_SETTINGS_FILE,
    createDefault: createDefaultAttachmentSettings,
    normalize: (input) => normalizeAttachmentSettings(input as Partial<AttachmentSettingsRecord> | undefined)
  },
  runHistory: {
    fileName: RUN_HISTORY_SETTINGS_FILE,
    createDefault: createDefaultRunHistorySettings,
    normalize: (input) => normalizeRunHistorySettings(input as Partial<RunHistorySettingsRecord> | undefined)
  }
};

const DEFAULT_CHECKPOINT_AUTO_CLEANUP_DAYS = 7;
const DEFAULT_CHECKPOINT_AUTO_DISMISS_SECONDS = 5;
export const DEFAULT_ATTACHMENT_MAX_STORED_INLINE_FILE_MB = 20;

export function createDefaultCheckpointMaintenanceSettings(): CheckpointMaintenanceSettingsRecord {
  return {
    autoCleanupEnabled: true,
    autoCleanupDays: DEFAULT_CHECKPOINT_AUTO_CLEANUP_DAYS,
    autoDismissEnabled: true,
    autoDismissSeconds: DEFAULT_CHECKPOINT_AUTO_DISMISS_SECONDS
  };
}

export function normalizeCheckpointMaintenanceSettings(input: Partial<CheckpointMaintenanceSettingsRecord> | undefined): CheckpointMaintenanceSettingsRecord {
  const autoCleanupEnabled = typeof input?.autoCleanupEnabled === 'boolean' ? input.autoCleanupEnabled : true;
  const rawDays = typeof input?.autoCleanupDays === 'number' && Number.isFinite(input.autoCleanupDays)
    ? Math.floor(input.autoCleanupDays)
    : DEFAULT_CHECKPOINT_AUTO_CLEANUP_DAYS;
  const autoDismissEnabled = typeof input?.autoDismissEnabled === 'boolean' ? input.autoDismissEnabled : true;
  const rawSeconds = typeof input?.autoDismissSeconds === 'number' && Number.isFinite(input.autoDismissSeconds)
    ? Math.floor(input.autoDismissSeconds)
    : DEFAULT_CHECKPOINT_AUTO_DISMISS_SECONDS;
  return {
    autoCleanupEnabled,
    autoCleanupDays: Math.min(3650, Math.max(1, rawDays)),
    autoDismissEnabled,
    autoDismissSeconds: Math.min(600, Math.max(1, rawSeconds))
  };
}

export const DEFAULT_APPEARANCE_STREAMING_TEXT_WAITING = '...少女等待中';
export const DEFAULT_APPEARANCE_STREAMING_TEXT_PREPARING = '...少女整理中';
export const DEFAULT_APPEARANCE_STREAMING_TEXT_THINKING = '...少女思考中';
export const DEFAULT_APPEARANCE_STREAMING_TEXT_WRITING = '...少女编写中';
export const DEFAULT_APPEARANCE_STREAMING_TEXT_TOOL_EXECUTING = '...少女执行中';

export function createDefaultAppearanceSettings(): AppearanceSettingsRecord {
  return {
    streamingTextPreparing: DEFAULT_APPEARANCE_STREAMING_TEXT_PREPARING,
    streamingTextWaiting: DEFAULT_APPEARANCE_STREAMING_TEXT_WAITING,
    streamingTextThinking: DEFAULT_APPEARANCE_STREAMING_TEXT_THINKING,
    streamingTextWriting: DEFAULT_APPEARANCE_STREAMING_TEXT_WRITING,
    streamingTextToolExecuting: DEFAULT_APPEARANCE_STREAMING_TEXT_TOOL_EXECUTING
  };
}

export function normalizeAppearanceSettings(input: Partial<AppearanceSettingsRecord> | undefined): AppearanceSettingsRecord {
  const sanitize = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return {
    streamingTextPreparing: sanitize(input?.streamingTextPreparing, DEFAULT_APPEARANCE_STREAMING_TEXT_PREPARING),
    streamingTextWaiting: sanitize(input?.streamingTextWaiting, DEFAULT_APPEARANCE_STREAMING_TEXT_WAITING),
    streamingTextThinking: sanitize(input?.streamingTextThinking, DEFAULT_APPEARANCE_STREAMING_TEXT_THINKING),
    streamingTextWriting: sanitize(input?.streamingTextWriting, DEFAULT_APPEARANCE_STREAMING_TEXT_WRITING),
    streamingTextToolExecuting: sanitize(input?.streamingTextToolExecuting, DEFAULT_APPEARANCE_STREAMING_TEXT_TOOL_EXECUTING)
  };
}

export function createDefaultAttachmentSettings(): AttachmentSettingsRecord {
  return { maxStoredInlineFileMb: DEFAULT_ATTACHMENT_MAX_STORED_INLINE_FILE_MB };
}

export function normalizeAttachmentSettings(input: Partial<AttachmentSettingsRecord> | undefined): AttachmentSettingsRecord {
  const number = Number(input?.maxStoredInlineFileMb);
  const normalized = Number.isFinite(number)
    ? Math.floor(number)
    : DEFAULT_ATTACHMENT_MAX_STORED_INLINE_FILE_MB;
  return {
    maxStoredInlineFileMb: Math.min(200, Math.max(1, normalized))
  };
}

export function createDefaultRunHistorySettings(): RunHistorySettingsRecord {
  return { detailPersistenceEnabled: false };
}

export function normalizeRunHistorySettings(input: Partial<RunHistorySettingsRecord> | undefined): RunHistorySettingsRecord {
  return { detailPersistenceEnabled: input?.detailPersistenceEnabled === true };
}

export async function ensureGlobalSettingsFile(root: vscode.Uri, section: GlobalSettingsSection): Promise<void> {
  await loadGlobalSettingsFile(root, section);
}

export async function loadGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection
): Promise<GlobalSettingsFileResult> {
  const uri = globalSettingsFileUri(root, section);
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') return initializeMissingGlobalSettingsFile(root, section);
  if (result.status !== 'ok') throw strictJsonReadError('global settings', section, result);

  return materializeGlobalSettingsFile(root, section, result.value);
}

/**
 * 基于一致快照提交文件型全局设置。普通业务提交必须携带读取时拿到的 revision；
 * 比较、写入和 next revision 返回都在同一资源锁内完成。
 */
export async function writeGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection,
  settings: GlobalSettingsSectionValue,
  expectedRevision: string
): Promise<GlobalSettingsFileResult> {
  const uri = globalSettingsFileUri(root, section);
  return withStorageResourceLock(uri, async () => {
    const current = await readJsonStrict<unknown>(uri);
    let previous: GlobalSettingsFileResult | undefined;
    if (current.status === 'ok') previous = materializeGlobalSettingsFile(root, section, current.value);
    else if (current.status !== 'missing') throw strictJsonReadError('global settings', section, current);

    const actualRevision = previous?.revision ?? missingGlobalSettingsRevision(uri, section);
    if (actualRevision !== expectedRevision) {
      throw new SettingsRevisionConflictError(section, expectedRevision, actualRevision);
    }
    const committed = await writeGlobalSettingsFileUnlocked(uri, section, settings);
    return {
      ...committed,
      ...(previous ? { previousSettings: previous.settings } : {})
    };
  });
}

export function globalSettingsFileUri(root: vscode.Uri, section: GlobalSettingsSection): vscode.Uri {
  return vscode.Uri.joinPath(root, getFileBackedSpec(section).fileName);
}

async function initializeMissingGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection
): Promise<GlobalSettingsFileResult> {
  const uri = globalSettingsFileUri(root, section);
  return withStorageResourceLock(uri, async () => {
    const current = await readJsonStrict<unknown>(uri);
    if (current.status === 'missing') {
      const defaults = getFileBackedSpec(section).createDefault();
      return writeGlobalSettingsFileUnlocked(uri, section, defaults);
    }
    if (current.status !== 'ok') throw strictJsonReadError('global settings', section, current);
    return materializeGlobalSettingsFile(root, section, current.value);
  });
}

function materializeGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection,
  value: unknown
): GlobalSettingsFileResult {
  const uri = globalSettingsFileUri(root, section);
  const spec = getFileBackedSpec(section);
  const file = parseGlobalSettingsFile(section, uri, value);
  const settings = spec.normalize(file.settings as Partial<GlobalSettingsSectionValue> | undefined);
  return {
    section,
    settings,
    filePath: uri.fsPath,
    revision: createStorageRevision(settings)
  };
}

async function writeGlobalSettingsFileUnlocked(
  uri: vscode.Uri,
  section: GlobalSettingsSection,
  settings: GlobalSettingsSectionValue
): Promise<GlobalSettingsFileResult> {
  const spec = getFileBackedSpec(section);
  const normalized = spec.normalize(settings as Partial<GlobalSettingsSectionValue> | undefined);
  await writeJson(uri, {
    schemaVersion: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    settings: normalized
  } satisfies GlobalSettingsFile<GlobalSettingsSectionValue>);
  return {
    section,
    settings: normalized,
    filePath: uri.fsPath,
    revision: createStorageRevision(normalized)
  };
}

function missingGlobalSettingsRevision(uri: vscode.Uri, section: GlobalSettingsSection): string {
  return createMissingStorageRevision(`global-settings:${section}:${uri.toString()}`);
}

function parseGlobalSettingsFile(
  section: GlobalSettingsSection,
  uri: vscode.Uri,
  value: unknown
): GlobalSettingsFile<GlobalSettingsSectionValue> {
  const file = asPlainObject(value);
  if (!file) throw new Error(`Invalid global settings file structure for ${section}: ${uri.fsPath}`);
  if (file.schemaVersion !== STORAGE_VERSION) {
    throw new Error(`Unsupported global settings schema for ${section}: ${uri.fsPath}`);
  }
  if (typeof file.savedAt !== 'string' || !file.savedAt.trim()) {
    throw new Error(`Invalid global settings savedAt for ${section}: ${uri.fsPath}`);
  }
  if (!isValidGlobalSettingsSectionValue(section, file.settings)) {
    throw new Error(`Invalid global settings payload for ${section}: ${uri.fsPath}`);
  }
  return {
    schemaVersion: STORAGE_VERSION,
    savedAt: file.savedAt,
    settings: file.settings
  };
}

function isValidGlobalSettingsSectionValue(section: GlobalSettingsSection, value: unknown): value is GlobalSettingsSectionValue {
  const record = asPlainObject(value);
  if (!record) return false;
  switch (section) {
    case 'llm':
      return typeof record.activeProviderConfigId === 'string';
    case 'llmCompression':
      return (record.defaultConfigId === undefined || typeof record.defaultConfigId === 'string')
        && Array.isArray(record.providerBindings)
        && record.providerBindings.every(isLlmCompressionProviderBindingLike)
        && Array.isArray(record.modelBindings)
        && record.modelBindings.every(isLlmCompressionModelBindingLike);
    case 'checkpointMaintenance':
      return typeof record.autoCleanupEnabled === 'boolean'
        && typeof record.autoCleanupDays === 'number'
        && Number.isFinite(record.autoCleanupDays)
        && typeof record.autoDismissEnabled === 'boolean'
        && typeof record.autoDismissSeconds === 'number'
        && Number.isFinite(record.autoDismissSeconds);
    case 'appearance':
      return typeof record.streamingTextPreparing === 'string'
        && typeof record.streamingTextWaiting === 'string'
        && typeof record.streamingTextThinking === 'string'
        && typeof record.streamingTextWriting === 'string'
        && typeof record.streamingTextToolExecuting === 'string';
    case 'attachments':
      return typeof record.maxStoredInlineFileMb === 'number' && Number.isFinite(record.maxStoredInlineFileMb);
    case 'runHistory':
      return typeof record.detailPersistenceEnabled === 'boolean';
    default:
      return false;
  }
}

function isLlmCompressionProviderBindingLike(value: unknown): boolean {
  const record = asPlainObject(value);
  return !!record
    && typeof record.id === 'string'
    && typeof record.providerConfigId === 'string'
    && typeof record.compressionConfigId === 'string'
    && record.role === 'default'
    && typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt)
    && typeof record.updatedAt === 'number'
    && Number.isFinite(record.updatedAt);
}

function isLlmCompressionModelBindingLike(value: unknown): boolean {
  const record = asPlainObject(value);
  return !!record
    && typeof record.id === 'string'
    && typeof record.providerConfigId === 'string'
    && typeof record.modelId === 'string'
    && typeof record.compressionConfigId === 'string'
    && record.role === 'model'
    && typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt)
    && typeof record.updatedAt === 'number'
    && Number.isFinite(record.updatedAt);
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strictJsonReadError(
  label: string,
  section: GlobalSettingsSection,
  result: Exclude<StrictJsonReadResult<unknown>, { status: 'ok' | 'missing' }>
): Error {
  const reason = result.status === 'invalid' ? 'invalid JSON' : 'I/O error';
  const message = result.error instanceof Error ? result.error.message : String(result.error);
  return new Error(`Failed to read ${label} ${section} (${reason}): ${result.uri.fsPath}. ${message}`);
}

function getFileBackedSpec(section: GlobalSettingsSection): (typeof GLOBAL_SETTINGS_SECTION_SPECS)[FileBackedGlobalSettingsSection] {
  if (section === 'common' || section === 'llmProviderConfigs' || section === 'llmCompressionConfigs' || section === 'mcpServers') {
    throw new Error(`Global settings section "${section}" is not stored by the generic file-backed settings handler.`);
  }
  return GLOBAL_SETTINGS_SECTION_SPECS[section];
}
