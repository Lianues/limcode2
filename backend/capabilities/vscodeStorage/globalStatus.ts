import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GlobalSettingsRecord } from '../../../shared/protocol';
import { STORAGE_VERSION } from './constants';
import { readJsonStrict, writeJson, type StrictJsonReadResult } from './json';
import { withStorageResourceLock } from './storageResourceLock';
import { createStorageRevision } from './storageRevision';

export const LIMCODE_GLOBAL_STATUS_KEY = 'limcode.globalStatus';
export const LIMCODE_GLOBAL_STATUS_FILE = '.limcode-global-status.json';

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

/**
 * globalState 只作为 VS Code 管理的启动投影；跨 Extension Host 的并发权威是
 * globalStorageUri 下的 canonical status 文件。进程启动完成 ensureReady 后，所有
 * 同步路径解析都会命中这里维护的进程内 committed snapshot。
 */
const committedStatusByContext = new WeakMap<vscode.ExtensionContext, LimCodeGlobalStatus>();

/** 同步读取当前进程已确认的 status；仅在 ensureReady 前回退到 globalState 启动投影。 */
export function loadGlobalStatus(context: vscode.ExtensionContext): LimCodeGlobalStatus {
  return cloneStatus(committedStatusByContext.get(context) ?? normalizeStoredGlobalStatus(context));
}

/**
 * 从 canonical 文件加载同一份 committed status。文件缺失时只初始化一次；损坏或
 * I/O 错误会明确失败，绝不拿默认值覆盖可能仍可恢复的数据。
 */
export async function loadCommittedGlobalStatus(context: vscode.ExtensionContext): Promise<LimCodeGlobalStatus> {
  const uri = globalStatusFileUri(context);
  const initial = await readJsonStrict<unknown>(uri);
  if (initial.status === 'ok') return rememberCommittedStatus(context, parseGlobalStatusFile(uri, initial.value));
  if (initial.status !== 'missing') throw strictGlobalStatusReadError(initial);
  if (committedStatusByContext.has(context)) {
    throw new Error(`Canonical global status disappeared after initialization: ${uri.fsPath}`);
  }

  return withStorageResourceLock(uri, async () => {
    const current = await readJsonStrict<unknown>(uri);
    if (current.status === 'ok') return rememberCommittedStatus(context, parseGlobalStatusFile(uri, current.value));
    if (current.status !== 'missing') throw strictGlobalStatusReadError(current);
    if (committedStatusByContext.has(context)) {
      throw new Error(`Canonical global status disappeared during initialization: ${uri.fsPath}`);
    }

    const bootstrap = normalizeStoredGlobalStatus(context);
    await writeJson(uri, bootstrap);
    return rememberCommittedStatus(context, bootstrap);
  });
}

/**
 * 发布新的 canonical status。调用方必须持有稳定的 data-root migration lock，并已在
 * 同一锁内完成 expectedRevision 比对及目录复制。canonical 文件写成功即视为提交；
 * globalState 更新仅是启动投影，不得把已提交事务伪装成失败。
 */
export async function commitGlobalStatus(
  context: vscode.ExtensionContext,
  previous: LimCodeGlobalStatus,
  dataRootPath: string,
  proxy: string,
  lastMigration?: StorageRootMigrationStatus
): Promise<LimCodeGlobalStatus> {
  const status: LimCodeGlobalStatus = {
    schemaVersion: STORAGE_VERSION,
    dataRootPath: normalizeStatusDataRootPath(context, dataRootPath),
    proxy: typeof proxy === 'string' ? proxy.trim() : '',
    updatedAt: new Date().toISOString(),
    ...(lastMigration ? { lastMigration: normalizeRequiredMigration(lastMigration) }
      : previous.lastMigration ? { lastMigration: cloneMigration(previous.lastMigration) } : {})
  };

  await writeJson(globalStatusFileUri(context), status);
  rememberCommittedStatus(context, status);
  try {
    await context.globalState.update(LIMCODE_GLOBAL_STATUS_KEY, status);
  } catch (error) {
    console.warn('[LimCode] Canonical global status committed, but VS Code globalState projection update failed.', error);
  }
  return cloneStatus(status);
}

/** revision 不依赖 updatedAt/时钟精度，只覆盖会影响并发语义的 committed 内容。 */
export function globalStatusRevision(status: LimCodeGlobalStatus): string {
  return createStorageRevision({
    schemaVersion: status.schemaVersion,
    dataRootPath: status.dataRootPath,
    proxy: status.proxy,
    ...(status.lastMigration ? { lastMigration: status.lastMigration } : {})
  });
}

export function globalStatusFileUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, LIMCODE_GLOBAL_STATUS_FILE);
}

export function createGlobalSettingsRecord(
  context: vscode.ExtensionContext,
  status: LimCodeGlobalStatus = loadGlobalStatus(context)
): GlobalSettingsRecord {
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

function normalizeStoredGlobalStatus(context: vscode.ExtensionContext): LimCodeGlobalStatus {
  const stored = context.globalState.get<Partial<LimCodeGlobalStatus>>(LIMCODE_GLOBAL_STATUS_KEY);
  const dataRootPath = normalizeDataRootPath(stored?.dataRootPath, { fallbackToDefault: true });
  const proxy = typeof stored?.proxy === 'string' ? stored.proxy.trim() : '';
  const lastMigration = normalizeLastMigration(stored?.lastMigration);
  return {
    schemaVersion: STORAGE_VERSION,
    dataRootPath: sameFsPath(dataRootPath, context.globalStorageUri.fsPath) ? '' : dataRootPath,
    proxy,
    updatedAt: typeof stored?.updatedAt === 'string' && stored.updatedAt.trim() ? stored.updatedAt : new Date(0).toISOString(),
    ...(lastMigration ? { lastMigration } : {})
  };
}

function parseGlobalStatusFile(uri: vscode.Uri, value: unknown): LimCodeGlobalStatus {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!record || record.schemaVersion !== STORAGE_VERSION) {
    throw new Error(`Invalid global status schema: ${uri.fsPath}`);
  }
  if (typeof record.dataRootPath !== 'string' || typeof record.proxy !== 'string') {
    throw new Error(`Invalid global status settings: ${uri.fsPath}`);
  }
  if (typeof record.updatedAt !== 'string' || !record.updatedAt.trim()) {
    throw new Error(`Invalid global status updatedAt: ${uri.fsPath}`);
  }
  const lastMigration = record.lastMigration === undefined ? undefined : normalizeLastMigration(record.lastMigration);
  if (record.lastMigration !== undefined && !lastMigration) {
    throw new Error(`Invalid global status migration metadata: ${uri.fsPath}`);
  }
  return {
    schemaVersion: STORAGE_VERSION,
    dataRootPath: normalizeStatusDataRootPathFromCanonical(record.dataRootPath),
    proxy: record.proxy.trim(),
    updatedAt: record.updatedAt,
    ...(lastMigration ? { lastMigration } : {})
  };
}

function normalizeStatusDataRootPathFromCanonical(value: string): string {
  const normalized = normalizeDataRootPath(value);
  return normalized;
}

function rememberCommittedStatus(context: vscode.ExtensionContext, status: LimCodeGlobalStatus): LimCodeGlobalStatus {
  const snapshot = cloneStatus(status);
  committedStatusByContext.set(context, snapshot);
  return cloneStatus(snapshot);
}

function cloneStatus(status: LimCodeGlobalStatus): LimCodeGlobalStatus {
  return {
    ...status,
    ...(status.lastMigration ? { lastMigration: cloneMigration(status.lastMigration) } : {})
  };
}

function cloneMigration(status: StorageRootMigrationStatus): StorageRootMigrationStatus {
  return { fromPath: status.fromPath, toPath: status.toPath, migratedAt: status.migratedAt };
}

function normalizeRequiredMigration(input: StorageRootMigrationStatus): StorageRootMigrationStatus {
  const normalized = normalizeLastMigration(input);
  if (!normalized) throw new Error('Invalid storage root migration metadata.');
  return normalized;
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

function strictGlobalStatusReadError(
  result: Exclude<StrictJsonReadResult<unknown>, { status: 'ok' | 'missing' }>
): Error {
  const reason = result.status === 'invalid' ? 'invalid JSON' : 'I/O error';
  const message = result.error instanceof Error ? result.error.message : String(result.error);
  return new Error(`Failed to read canonical global status (${reason}): ${result.uri.fsPath}. ${message}`);
}
