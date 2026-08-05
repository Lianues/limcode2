import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isFileNotFoundError } from './json';
import { deleteStorageUri, readStorageDirectory } from './storageFs';

export const STORAGE_GENERATIONS_DIR = 'generations';

export interface StorageGenerationOptions {
  generationsDir?: string;
}

export interface StorageGenerationLocation {
  id: string;
  relativePath: string;
  rootUri: vscode.Uri;
}

export interface StorageGenerationCleanupFailure {
  generation: StorageGenerationLocation;
  error: unknown;
}

export interface StorageGenerationCleanupResult {
  deleted: StorageGenerationLocation[];
  failed: StorageGenerationCleanupFailure[];
}

export interface StorageGenerationCleanupOptions extends StorageGenerationOptions {
  /** 宽限期：这段时间内发布的 generation 即使已不再被索引引用也保留。传 0 关闭。 */
  retentionMs?: number;
  /** 宽限期内最多额外保留多少份，防止高频发布时无上限堆积。 */
  retentionLimit?: number;
  now?: number;
}

/**
 * 只保留 current + previous 两份时，两份可能只相隔几秒（事故中是 8 秒），一次掭电
 * 就能把它们同时写坏，于是整层数据无路可退。改成时间窗口后，崩溃时总能找到一份已经
 * fsync 落盘很久、不可能还在页缓存里的历史副本。
 */
export const DEFAULT_STORAGE_GENERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_STORAGE_GENERATION_RETENTION_LIMIT = 8;

const STORAGE_GENERATION_ID_PATTERN = /^\d{8}-\d{6}-\d{3}-[a-f0-9]{8}$/;
const STORAGE_GENERATION_CONTAINER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function createStorageGenerationId(date: Date = new Date()): string {
  const timestamp = [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
    '-',
    date.getUTCHours().toString().padStart(2, '0'),
    date.getUTCMinutes().toString().padStart(2, '0'),
    date.getUTCSeconds().toString().padStart(2, '0'),
    '-',
    date.getUTCMilliseconds().toString().padStart(3, '0')
  ].join('');
  return `${timestamp}-${randomBytes(4).toString('hex')}`;
}

export function isSafeStorageGenerationId(id: string): boolean {
  return STORAGE_GENERATION_ID_PATTERN.test(id);
}

export function assertSafeStorageGenerationId(id: string): string {
  if (!isSafeStorageGenerationId(id)) throw new Error(`Invalid storage generation id: ${id}`);
  return id;
}

export function getStorageGenerationsRootUri(baseRootUri: vscode.Uri, options: StorageGenerationOptions = {}): vscode.Uri {
  return vscode.Uri.joinPath(baseRootUri, normalizeGenerationsDir(options.generationsDir));
}

export function getStorageGenerationRelativePath(id: string, options: StorageGenerationOptions = {}): string {
  return `${normalizeGenerationsDir(options.generationsDir)}/${assertSafeStorageGenerationId(id)}`;
}

export function getStorageGenerationRootUri(baseRootUri: vscode.Uri, id: string, options: StorageGenerationOptions = {}): vscode.Uri {
  return vscode.Uri.joinPath(baseRootUri, ...getStorageGenerationRelativePath(id, options).split('/'));
}

export function createStorageGenerationLocation(baseRootUri: vscode.Uri, id: string = createStorageGenerationId(), options: StorageGenerationOptions = {}): StorageGenerationLocation {
  return {
    id: assertSafeStorageGenerationId(id),
    relativePath: getStorageGenerationRelativePath(id, options),
    rootUri: getStorageGenerationRootUri(baseRootUri, id, options)
  };
}

export async function listStorageGenerations(baseRootUri: vscode.Uri, options: StorageGenerationOptions = {}): Promise<StorageGenerationLocation[]> {
  const generationsRootUri = getStorageGenerationsRootUri(baseRootUri, options);
  let entries: [string, vscode.FileType][];
  try {
    entries = await readStorageDirectory(generationsRootUri);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }

  return entries
    .filter(([id, type]) => type === vscode.FileType.Directory && isSafeStorageGenerationId(id))
    .map(([id]) => createStorageGenerationLocation(baseRootUri, id, options))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** generation id 本身就是 UTC 时间戳，无需额外 stat 就能拿到发布时间。 */
export function parseStorageGenerationTimestamp(id: string): number | undefined {
  if (!isSafeStorageGenerationId(id)) return undefined;
  const month = Number(id.slice(4, 6));
  const day = Number(id.slice(6, 8));
  const hour = Number(id.slice(9, 11));
  const minute = Number(id.slice(11, 13));
  const second = Number(id.slice(13, 15));
  // Date.UTC 会把越界字段静默 rollover（20261301 会滞成 2027-01）。id 格式校验只管位数，
  // 损坏或伪造的 id 就能拿到一个未来时间戳，从而永久占用一个宽限期名额，因此显式拒掉。
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const timestamp = Date.UTC(
    Number(id.slice(0, 4)),
    month - 1,
    day,
    hour,
    minute,
    second,
    Number(id.slice(16, 19))
  );
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export async function cleanupInactiveStorageGenerations(
  baseRootUri: vscode.Uri,
  activeGenerationIds: Iterable<string>,
  options: StorageGenerationCleanupOptions = {}
): Promise<StorageGenerationCleanupResult> {
  const active = new Set<string>();
  for (const id of activeGenerationIds) active.add(assertSafeStorageGenerationId(id));

  const deleted: StorageGenerationLocation[] = [];
  const failed: StorageGenerationCleanupFailure[] = [];
  const generations = await listStorageGenerations(baseRootUri, options);
  const grace = graceRetainedGenerationIds(generations, active, options);
  for (const generation of generations) {
    if (active.has(generation.id) || grace.has(generation.id)) continue;
    try {
      await deleteStorageUri(generation.rootUri, { recursive: true, useTrash: false });
      deleted.push(generation);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        deleted.push(generation);
        continue;
      }
      failed.push({ generation, error });
    }
  }
  return { deleted, failed };
}

function graceRetainedGenerationIds(
  generations: readonly StorageGenerationLocation[],
  active: ReadonlySet<string>,
  options: StorageGenerationCleanupOptions
): Set<string> {
  const retentionMs = options.retentionMs ?? DEFAULT_STORAGE_GENERATION_RETENTION_MS;
  const retentionLimit = options.retentionLimit ?? DEFAULT_STORAGE_GENERATION_RETENTION_LIMIT;
  const grace = new Set<string>();
  if (retentionMs <= 0 || retentionLimit <= 0) return grace;

  const now = options.now ?? Date.now();
  // listStorageGenerations 已按 id 升序，倒序遍历即从最新开始取。
  for (let index = generations.length - 1; index >= 0 && grace.size < retentionLimit; index -= 1) {
    const generation = generations[index]!;
    if (active.has(generation.id)) continue;
    const publishedAt = parseStorageGenerationTimestamp(generation.id);
    // 时间戳解不出来时不保留，避免异常目录永久占用名额。
    if (publishedAt === undefined) continue;
    // 早于宽限期的都更旧，可以直接停止扫描。
    if (now - publishedAt > retentionMs) break;
    grace.add(generation.id);
  }
  return grace;
}

function normalizeGenerationsDir(value: string | undefined): string {
  const candidate = value?.trim() || STORAGE_GENERATIONS_DIR;
  if (!STORAGE_GENERATION_CONTAINER_PATTERN.test(candidate) || candidate === '.' || candidate === '..') {
    throw new Error(`Invalid storage generations directory: ${value}`);
  }
  return candidate;
}
