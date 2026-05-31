import * as vscode from 'vscode';
import type {
  GlobalSettingsSection,
  GlobalSettingsSectionValue,
  LlmSettingsRecord
} from '../../../shared/protocol';
import { LLM_SETTINGS_FILE, STORAGE_VERSION } from './constants';
import { readJson, writeJson } from './json';
import { createDefaultLlmSettings, normalizeLlmSettings } from './llmSettings';

interface GlobalSettingsFile<T> {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  settings: T;
}

type FileBackedGlobalSettingsSection = Exclude<GlobalSettingsSection, 'common'>;

const GLOBAL_SETTINGS_SECTION_SPECS: Record<FileBackedGlobalSettingsSection, {
  fileName: string;
  createDefault: () => GlobalSettingsSectionValue;
  normalize: (input: Partial<GlobalSettingsSectionValue> | undefined) => GlobalSettingsSectionValue;
}> = {
  llm: {
    fileName: LLM_SETTINGS_FILE,
    createDefault: createDefaultLlmSettings,
    normalize: (input) => normalizeLlmSettings(input as Partial<LlmSettingsRecord> | undefined)
  }
};

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
  if (section === 'common') {
    throw new Error('Global settings section "common" is stored in VS Code globalState, not in the data directory.');
  }
  return GLOBAL_SETTINGS_SECTION_SPECS[section];
}
