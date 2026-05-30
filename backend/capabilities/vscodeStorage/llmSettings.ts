import * as vscode from 'vscode';
import type { LlmProviderKind, LlmSettingsRecord } from '../../../shared/protocol';
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from '../llmProvider';
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
    ...settings
  } satisfies LlmSettingsFile);
}

export function createDefaultLlmSettings(): LlmSettingsRecord {
  return {
    provider: 'deepseek',
    baseUrl: DEFAULT_LLM_BASE_URL,
    model: DEFAULT_LLM_MODEL,
    apiKey: '',
    temperature: 0.2
  };
}

export function normalizeLlmSettings(input: Partial<LlmSettingsRecord> | undefined): LlmSettingsRecord {
  const defaults = createDefaultLlmSettings();
  const temperature = Number(input?.temperature ?? defaults.temperature);
  return {
    provider: isKnownProvider(input?.provider) ? input.provider : defaults.provider,
    baseUrl: stringOrDefault(input?.baseUrl, defaults.baseUrl),
    model: stringOrDefault(input?.model, defaults.model),
    apiKey: typeof input?.apiKey === 'string' ? input.apiKey.trim() : defaults.apiKey,
    temperature: Number.isFinite(temperature) ? temperature : defaults.temperature
  };
}

function sameLlmSettings(a: LlmSettingsRecord, b: Partial<LlmSettingsRecord>): boolean {
  return a.provider === b.provider &&
    a.baseUrl === b.baseUrl &&
    a.model === b.model &&
    a.apiKey === b.apiKey &&
    a.temperature === b.temperature;
}

function isKnownProvider(provider: unknown): provider is LlmProviderKind {
  return provider === 'deepseek' || provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'claude' || provider === 'gemini';
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
