import * as vscode from 'vscode';
import type { GlobalSettingsRecord } from '../../../shared/protocol';
import { STORAGE_VERSION } from './constants';
import { readJson, writeJson } from './json';
import { createDefaultLlmSettings, normalizeLlmSettings } from './llmSettings';

interface GlobalSettingsFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  settings: GlobalSettingsRecord;
}

export async function ensureGlobalSettingsFile(uri: vscode.Uri): Promise<void> {
  const file = await readJson<GlobalSettingsFile>(uri);
  if (file?.schemaVersion === STORAGE_VERSION) return;
  await writeGlobalSettingsFile(uri, createDefaultGlobalSettings());
}

export async function loadGlobalSettingsFile(uri: vscode.Uri): Promise<GlobalSettingsRecord> {
  const file = await readJson<GlobalSettingsFile>(uri);
  if (!file || file.schemaVersion !== STORAGE_VERSION) {
    const defaults = createDefaultGlobalSettings();
    await writeGlobalSettingsFile(uri, defaults);
    return defaults;
  }

  const settings = normalizeGlobalSettings(file.settings);
  if (!sameGlobalSettings(settings, file.settings)) {
    await writeGlobalSettingsFile(uri, settings);
  }
  return settings;
}

export async function writeGlobalSettingsFile(uri: vscode.Uri, settings: GlobalSettingsRecord): Promise<void> {
  await writeJson(uri, {
    schemaVersion: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    settings: normalizeGlobalSettings(settings)
  } satisfies GlobalSettingsFile);
}

export function createDefaultGlobalSettings(): GlobalSettingsRecord {
  return {
    llm: createDefaultLlmSettings(),
    dataFilePath: ''
  };
}

export function normalizeGlobalSettings(input: Partial<GlobalSettingsRecord> | undefined): GlobalSettingsRecord {
  const defaults = createDefaultGlobalSettings();
  return {
    llm: normalizeLlmSettings(input?.llm),
    dataFilePath: typeof input?.dataFilePath === 'string' ? input.dataFilePath.trim() : defaults.dataFilePath
  };
}

function sameGlobalSettings(a: GlobalSettingsRecord, b: Partial<GlobalSettingsRecord>): boolean {
  return JSON.stringify(a) === JSON.stringify(normalizeGlobalSettings(b));
}
