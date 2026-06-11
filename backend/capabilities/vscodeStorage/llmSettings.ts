import * as vscode from 'vscode';
import type { LlmSettingsRecord } from '../../../shared/protocol';
import { STORAGE_VERSION } from './constants';
import { readJson, writeJson } from './json';

interface LlmSettingsFile extends LlmSettingsRecord {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
}

export async function ensureLlmSettingsFile(uri: vscode.Uri): Promise<void> {
  const settings = await readJson<LlmSettingsFile>(uri);
  if (settings?.schemaVersion === STORAGE_VERSION) return;
  await writeLlmSettingsFile(uri, createDefaultLlmSettings());
}

export async function loadLlmSettingsFile(uri: vscode.Uri): Promise<LlmSettingsRecord> {
  const file = await readJson<LlmSettingsFile>(uri);
  if (!file || file.schemaVersion !== STORAGE_VERSION) {
    const defaults = createDefaultLlmSettings();
    await writeLlmSettingsFile(uri, defaults);
    return defaults;
  }

  const settings = normalizeLlmSettings(file);
  if (!sameLlmSettings(settings, file)) {
    await writeLlmSettingsFile(uri, settings);
  }
  return settings;
}

export async function writeLlmSettingsFile(uri: vscode.Uri, settings: LlmSettingsRecord): Promise<void> {
  await writeJson(uri, {
    schemaVersion: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    ...normalizeLlmSettings(settings)
  } satisfies LlmSettingsFile);
}

export function createDefaultLlmSettings(): LlmSettingsRecord {
  return { activeProviderConfigId: '' };
}

export function normalizeLlmSettings(input: Partial<LlmSettingsRecord> | undefined): LlmSettingsRecord {
  return {
    activeProviderConfigId: typeof input?.activeProviderConfigId === 'string' ? input.activeProviderConfigId.trim() : ''
  };
}

function sameLlmSettings(a: LlmSettingsRecord, b: Partial<LlmSettingsRecord>): boolean {
  return a.activeProviderConfigId === b.activeProviderConfigId;
}
