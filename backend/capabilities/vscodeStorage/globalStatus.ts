import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GlobalSettingsRecord } from '../../../shared/protocol';
import { STORAGE_VERSION } from './constants';

export const LIMCODE_GLOBAL_STATUS_KEY = 'limcode.globalStatus';
export const LIMCODE_GLOBAL_STATUS_LABEL = `VS Code globalState: ${LIMCODE_GLOBAL_STATUS_KEY}`;

export interface StorageRootMigrationStatus {
  fromPath: string;
  toPath: string;
  migratedAt: string;
}

export interface LimCodeGlobalStatus {
  schemaVersion: typeof STORAGE_VERSION;
  dataRootPath: string;
  proxy: string;
  updatedAt: string;
  lastMigration?: StorageRootMigrationStatus;
}

export function loadGlobalStatus(context: vscode.ExtensionContext): LimCodeGlobalStatus {
  const stored = context.globalState.get<Partial<LimCodeGlobalStatus>>(LIMCODE_GLOBAL_STATUS_KEY);
  const dataRootPath = normalizeDataRootPath(stored?.dataRootPath, { fallbackToDefault: true });
  const proxy = typeof stored?.proxy === 'string' ? stored.proxy.trim() : '';
  const lastMigration = normalizeLastMigration(stored?.lastMigration);

  return {
    schemaVersion: STORAGE_VERSION,
    dataRootPath: sameFsPath(dataRootPath, context.globalStorageUri.fsPath) ? '' : dataRootPath,
    proxy,
    updatedAt: typeof stored?.updatedAt === 'string' ? stored.updatedAt : '',
    ...(lastMigration ? { lastMigration } : {})
  };
}

export async function saveGlobalStatus(
  context: vscode.ExtensionContext,
  dataRootPath: string,
  proxy: string,
  lastMigration?: StorageRootMigrationStatus
): Promise<LimCodeGlobalStatus> {
  const previous = loadGlobalStatus(context);
  const normalizedDataRootPath = normalizeStatusDataRootPath(context, dataRootPath);
  const normalizedProxy = typeof proxy === 'string' ? proxy.trim() : '';
  const status: LimCodeGlobalStatus = {
    schemaVersion: STORAGE_VERSION,
    dataRootPath: normalizedDataRootPath,
    proxy: normalizedProxy,
    updatedAt: new Date().toISOString(),
    ...(lastMigration ? { lastMigration } : previous.lastMigration ? { lastMigration: previous.lastMigration } : {})
  };
  await context.globalState.update(LIMCODE_GLOBAL_STATUS_KEY, status);
  return status;
}

export function createGlobalSettingsRecord(context: vscode.ExtensionContext): GlobalSettingsRecord {
  const status = loadGlobalStatus(context);
  return {
    dataFilePath: status.dataRootPath,
    proxy: status.proxy,
    activeDataRootPath: resolveDataRootUri(context, status.dataRootPath).fsPath,
    defaultDataRootPath: context.globalStorageUri.fsPath
  };
}

export function resolveDataRootUri(context: vscode.ExtensionContext, dataRootPath = loadGlobalStatus(context).dataRootPath): vscode.Uri {
  const normalizedDataRootPath = normalizeStatusDataRootPath(context, dataRootPath);
  return normalizedDataRootPath ? vscode.Uri.file(normalizedDataRootPath) : context.globalStorageUri;
}

export function normalizeStatusDataRootPath(context: vscode.ExtensionContext, value: unknown): string {
  const normalized = normalizeDataRootPath(value);
  if (!normalized) return '';
  return sameFsPath(normalized, context.globalStorageUri.fsPath) ? '' : normalized;
}

export function normalizeDataRootPath(value: unknown, options: { fallbackToDefault?: boolean } = {}): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  if (!path.isAbsolute(trimmed)) {
    if (options.fallbackToDefault) return '';
    throw new Error('数据目录路径必须是绝对路径。');
  }
  return path.resolve(trimmed);
}

export function sameFsPath(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  return comparableFsPath(a) === comparableFsPath(b);
}

export function comparableFsPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeLastMigration(input: unknown): StorageRootMigrationStatus | undefined {
  const candidate = input as Partial<StorageRootMigrationStatus> | undefined;
  if (
    typeof candidate?.fromPath !== 'string'
    || typeof candidate.toPath !== 'string'
    || typeof candidate.migratedAt !== 'string'
  ) return undefined;
  return {
    fromPath: candidate.fromPath,
    toPath: candidate.toPath,
    migratedAt: candidate.migratedAt
  };
}
