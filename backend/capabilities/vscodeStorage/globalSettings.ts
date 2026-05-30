import * as vscode from 'vscode';
import type {
  GlobalSettingsRecord,
  GlobalSettingsSection,
  GlobalSettingsSectionValue,
  LlmSettingsRecord
} from '../../../shared/protocol';
import { GLOBAL_SETTINGS_FILE, LLM_SETTINGS_FILE, STORAGE_VERSION } from './constants';
import { readJson, writeJson } from './json';
import { createDefaultLlmSettings, normalizeLlmSettings } from './llmSettings';

interface GlobalSettingsFile<T> {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  settings: T;
}

const GLOBAL_SETTINGS_SECTION_SPECS = {
  common: {
    fileName: GLOBAL_SETTINGS_FILE,
    createDefault: createDefaultGlobalSettings,
    normalize: normalizeCommonGlobalSettings
  },
  llm: {
    fileName: LLM_SETTINGS_FILE,
    createDefault: createDefaultLlmSettings,
    normalize: normalizeLlmSettings
  }
};

export async function ensureGlobalSettingsFile(root: vscode.Uri, section: GlobalSettingsSection): Promise<void> {
  const uri = globalSettingsFileUri(root, section);
  const spec = GLOBAL_SETTINGS_SECTION_SPECS[section];
  const file = await readJson<GlobalSettingsFile<GlobalSettingsSectionValue>>(uri);
  if (file?.schemaVersion === STORAGE_VERSION) return;
  await writeGlobalSettingsFile(root, section, spec.createDefault());
}

export async function loadGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection
): Promise<{ section: GlobalSettingsSection; settings: GlobalSettingsSectionValue; filePath: string }> {
  const uri = globalSettingsFileUri(root, section);
  const spec = GLOBAL_SETTINGS_SECTION_SPECS[section];
  const file = await readJson<GlobalSettingsFile<GlobalSettingsSectionValue>>(uri);
  if (!file || file.schemaVersion !== STORAGE_VERSION) {
    const defaults = spec.createDefault();
    await writeGlobalSettingsFile(root, section, defaults);
    return { section, settings: defaults, filePath: uri.fsPath };
  }

  const settings = normalizeSection(section, file.settings);
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
  await writeJson(globalSettingsFileUri(root, section), {
    schemaVersion: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    settings: normalizeSection(section, settings)
  } satisfies GlobalSettingsFile<GlobalSettingsSectionValue>);
}

export function globalSettingsFileUri(root: vscode.Uri, section: GlobalSettingsSection): vscode.Uri {
  return vscode.Uri.joinPath(root, GLOBAL_SETTINGS_SECTION_SPECS[section].fileName);
}

export function createDefaultGlobalSettings(): GlobalSettingsRecord {
  return {
    dataFilePath: ''
  };
}

function normalizeCommonGlobalSettings(input: Partial<GlobalSettingsRecord> | undefined): GlobalSettingsRecord {
  const defaults = createDefaultGlobalSettings();
  return {
    dataFilePath: typeof input?.dataFilePath === 'string' ? input.dataFilePath.trim() : defaults.dataFilePath
  };
}

function normalizeSection(section: GlobalSettingsSection, input: Partial<GlobalSettingsSectionValue> | undefined): GlobalSettingsSectionValue {
  if (section === 'llm') return normalizeLlmSettings(input as Partial<LlmSettingsRecord> | undefined);
  return normalizeCommonGlobalSettings(input as Partial<GlobalSettingsRecord> | undefined);
}

function sameSettings(section: GlobalSettingsSection, a: GlobalSettingsSectionValue, b: Partial<GlobalSettingsSectionValue>): boolean {
  return JSON.stringify(a) === JSON.stringify(normalizeSection(section, b));
}
