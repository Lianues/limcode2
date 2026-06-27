import * as vscode from 'vscode';
import type {
  AttachmentSettingsRecord,
  AppearanceSettingsRecord,
  CheckpointMaintenanceSettingsRecord,
  GlobalSettingsSection,
  GlobalSettingsSectionValue,
  LlmCompressionSettingsRecord,
  LlmSettingsRecord
} from '../../../shared/protocol';
import { createDefaultLlmCompressionSettings } from '../../../shared/protocol';
import { ATTACHMENT_SETTINGS_FILE, CHECKPOINT_MAINTENANCE_SETTINGS_FILE, LLM_COMPRESSION_SETTINGS_FILE, LLM_SETTINGS_FILE, STORAGE_VERSION } from './constants';
import { APPEARANCE_SETTINGS_FILE } from './constants';
import { readJson, writeJson } from './json';
import { createDefaultLlmSettings, normalizeLlmSettings } from './llmSettings';
import { normalizeLlmCompressionSettings } from './llmCompressionConfigs';

interface GlobalSettingsFile<T> {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  settings: T;
}

type FileBackedGlobalSettingsSection = Exclude<GlobalSettingsSection, 'common' | 'llmProviderConfigs' | 'llmCompressionConfigs'>;

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
export const DEFAULT_APPEARANCE_STREAMING_TEXT_THINKING = '...少女思考中';
export const DEFAULT_APPEARANCE_STREAMING_TEXT_WRITING = '...少女编写中';

export function createDefaultAppearanceSettings(): AppearanceSettingsRecord {
  return {
    streamingTextWaiting: DEFAULT_APPEARANCE_STREAMING_TEXT_WAITING,
    streamingTextThinking: DEFAULT_APPEARANCE_STREAMING_TEXT_THINKING,
    streamingTextWriting: DEFAULT_APPEARANCE_STREAMING_TEXT_WRITING
  };
}

export function normalizeAppearanceSettings(input: Partial<AppearanceSettingsRecord> | undefined): AppearanceSettingsRecord {
  const sanitize = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return {
    streamingTextWaiting: sanitize(input?.streamingTextWaiting, DEFAULT_APPEARANCE_STREAMING_TEXT_WAITING),
    streamingTextThinking: sanitize(input?.streamingTextThinking, DEFAULT_APPEARANCE_STREAMING_TEXT_THINKING),
    streamingTextWriting: sanitize(input?.streamingTextWriting, DEFAULT_APPEARANCE_STREAMING_TEXT_WRITING)
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

export async function ensureGlobalSettingsFile(root: vscode.Uri, section: GlobalSettingsSection): Promise<void> {
  const spec = getFileBackedSpec(section);
  const uri = globalSettingsFileUri(root, section);
  const file = await readJson<GlobalSettingsFile<GlobalSettingsSectionValue>>(uri);
  if (file?.schemaVersion === STORAGE_VERSION) return;
  await writeGlobalSettingsFile(root, section, spec.createDefault());
}

export async function loadGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection
): Promise<{ section: GlobalSettingsSection; settings: GlobalSettingsSectionValue; filePath: string }> {
  const uri = globalSettingsFileUri(root, section);
  const spec = getFileBackedSpec(section);
  const file = await readJson<GlobalSettingsFile<GlobalSettingsSectionValue>>(uri);
  if (!file || file.schemaVersion !== STORAGE_VERSION) {
    const defaults = spec.createDefault();
    await writeGlobalSettingsFile(root, section, defaults);
    return { section, settings: defaults, filePath: uri.fsPath };
  }

  const settings = spec.normalize(file.settings as Partial<GlobalSettingsSectionValue> | undefined);
  if (!sameSettings(section, settings, file.settings)) {
    await writeGlobalSettingsFile(root, section, settings);
  }
  return { section, settings, filePath: uri.fsPath };
}

export async function writeGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection,
  settings: GlobalSettingsSectionValue
): Promise<void> {
  const spec = getFileBackedSpec(section);
  await writeJson(globalSettingsFileUri(root, section), {
    schemaVersion: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    settings: spec.normalize(settings as Partial<GlobalSettingsSectionValue> | undefined)
  } satisfies GlobalSettingsFile<GlobalSettingsSectionValue>);
}

export function globalSettingsFileUri(root: vscode.Uri, section: GlobalSettingsSection): vscode.Uri {
  return vscode.Uri.joinPath(root, getFileBackedSpec(section).fileName);
}

function sameSettings(section: GlobalSettingsSection, a: GlobalSettingsSectionValue, b: Partial<GlobalSettingsSectionValue>): boolean {
  const spec = getFileBackedSpec(section);
  return JSON.stringify(a) === JSON.stringify(spec.normalize(b));
}

function getFileBackedSpec(section: GlobalSettingsSection): (typeof GLOBAL_SETTINGS_SECTION_SPECS)[FileBackedGlobalSettingsSection] {
  if (section === 'common' || section === 'llmProviderConfigs' || section === 'llmCompressionConfigs') {
    throw new Error(`Global settings section "${section}" is not stored by the generic file-backed settings handler.`);
  }
  return GLOBAL_SETTINGS_SECTION_SPECS[section];
}
