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
  /**
   * 各 store 显式声明的保留时间桶上界。每个桶只保留一份最老 generation，避免高频写入
   * 把所有备份都集中在几秒内。例如 [1m, 10m, 1h, 24h] 最多保留四个跨时间 checkpoint。
   */
  retentionBucketsMs?: readonly number[];
  /** 只有这些已确认发布的 generation 才能进入时间桶；未传时默认所有 generation 均可。 */
  retentionEligibleGenerationIds?: Iterable<string>;
  now?: number;
}

/** 各 generation store 必须显式选择是否使用该标准恢复深度。 */
export const STANDARD_STORAGE_GENERATION_RETENTION_BUCKETS_MS = [
  60_000,
  10 * 60_000,
  60 * 60_000,
  24 * 60 * 60_000
] as const;

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
  const year = Number(id.slice(0, 4));
  const month = Number(id.slice(4, 6));
  const day = Number(id.slice(6, 8));
  const hour = Number(id.slice(9, 11));
  const minute = Number(id.slice(11, 13));
  const second = Number(id.slice(13, 15));
  const millisecond = Number(id.slice(16, 19));
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (!Number.isFinite(timestamp)) return undefined;
  const parsed = new Date(timestamp);
  // Date.UTC 会把 2 月 31 日、非闰年 2 月 29 日等静默 rollover，必须逐字段回读确认。
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second
    || parsed.getUTCMilliseconds() !== millisecond) return undefined;
  return timestamp;
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
  const buckets = normalizeRetentionBuckets(options.retentionBucketsMs);
  const grace = new Set<string>();
  if (buckets.length === 0) return grace;

  const now = options.now ?? Date.now();
  const eligible = options.retentionEligibleGenerationIds
    ? new Set(options.retentionEligibleGenerationIds)
    : undefined;
  const selected = new Map<number, { generation: StorageGenerationLocation; ageMs: number }>();
  for (const generation of generations) {
    if (active.has(generation.id) || eligible && !eligible.has(generation.id)) continue;
    const publishedAt = parseStorageGenerationTimestamp(generation.id);
    if (publishedAt === undefined) continue;
    // 时钟回拨时把未来 generation 视为刚发布；每桶仍只保留一份，不会无上限占用名额。
    const ageMs = Math.max(0, now - publishedAt);
    const bucketIndex = buckets.findIndex((upperBoundMs) => ageMs <= upperBoundMs);
    if (bucketIndex < 0) continue;
    const current = selected.get(bucketIndex);
    // 每个时间桶选择最老的一份，让 checkpoint 尽量靠近桶上界，而不是都挤在“刚刚”。
    if (!current || ageMs > current.ageMs) selected.set(bucketIndex, { generation, ageMs });
  }
  for (const checkpoint of selected.values()) grace.add(checkpoint.generation.id);
  return grace;
}

function normalizeRetentionBuckets(value: readonly number[] | undefined): number[] {
  if (!value?.length) return [];
  return [...new Set(value
    .filter((candidate) => Number.isFinite(candidate) && candidate > 0)
    .map((candidate) => Math.floor(candidate)))]
    .sort((a, b) => a - b);
}

function normalizeGenerationsDir(value: string | undefined): string {
  const candidate = value?.trim() || STORAGE_GENERATIONS_DIR;
  if (!STORAGE_GENERATION_CONTAINER_PATTERN.test(candidate) || candidate === '.' || candidate === '..') {
    throw new Error(`Invalid storage generations directory: ${value}`);
  }
  return candidate;
}
