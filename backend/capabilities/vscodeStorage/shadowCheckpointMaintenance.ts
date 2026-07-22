import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import type { CheckpointRecord, ConversationCheckpointRepositoryLinkRecord, ShadowRepositoryDiskStatRecord, ShadowRepositoryRecord } from '../../../shared/protocol';
import type { StoragePaths } from './clientStateStore';
import { loadRecordStore } from './recordStore';
import { withClientStateSkeletonReadTransaction } from './clientStateSkeletonTransaction';
import {
  SHADOW_WORKTREE_LOCKS_DIR,
  deleteShadowWorktreeDirectory,
  isShadowWorktreeDirectoryName,
  shadowWorktreePath,
  withShadowWorktreeLock
} from './shadowWorktreeLock';

const SCAN_TEMP_PREFIX = '.checkpoint-scan-';
const RESTORE_TEMP_PREFIX = '.checkpoint-restore-';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface WorktreeAggregate {
  sizeBytes: number;
  fileCount: number;
  lastActiveAt: number;
}

export interface ShadowCleanupTestHooks {
  afterCollectStaleCandidates?: (storageKeys: readonly string[]) => void | Promise<void>;
}

export const __shadowCleanupTestHooks: ShadowCleanupTestHooks = {};

/** 扫描 shadow worktrees 根目录，统计每个 worktree 的磁盘占用、项目文件数与最近活跃时间。 */
export async function collectShadowWorktreeStats(paths: StoragePaths): Promise<ShadowRepositoryDiskStatRecord[]> {
  const root = paths.checkpointShadowWorktreesRootPath;
  const entries = await readDirSafe(root);
  const stats: Array<ShadowRepositoryDiskStatRecord | undefined> = await Promise.all(entries.map(async (entry) => {
    if (!isCandidateWorktreeEntry(entry)) return undefined;
    return withShadowWorktreeLock(root, entry.name, async ({ storageKey, worktreePath }) => {
      // 扫描后先拿 key 锁，并在锁内 recheck，避免 delete/cleanup 并发造成半状态。
      const stat = await fs.stat(worktreePath).catch(() => undefined);
      if (!stat?.isDirectory()) return undefined;
      const aggregate = await aggregateWorktree(worktreePath);
      return {
        storageKey,
        exists: true,
        sizeBytes: aggregate.sizeBytes,
        fileCount: aggregate.fileCount,
        ...(aggregate.lastActiveAt > 0 ? { lastActiveAt: aggregate.lastActiveAt } : {})
      } satisfies ShadowRepositoryDiskStatRecord;
    }).catch((error) => {
      console.warn(`[LimCode] Failed to collect shadow worktree stats: ${entry.name}`, error);
      return undefined;
    });
  }));
  const collected = stats.filter((item): item is ShadowRepositoryDiskStatRecord => item !== undefined);
  return collected.sort((left, right) => right.sizeBytes - left.sizeBytes || left.storageKey.localeCompare(right.storageKey));
}

/** 删除指定 storageKey 对应的物理 shadow worktree（不触碰 ECS / skeleton 记录）。 */
export async function deleteShadowWorktrees(paths: StoragePaths, storageKeys: readonly string[]): Promise<{ deletedStorageKeys: string[] }> {
  const root = paths.checkpointShadowWorktreesRootPath;
  const uniqueKeys = [...new Set(storageKeys)];
  const results = await Promise.all(uniqueKeys.map(async (rawKey) => {
    const target = shadowWorktreePath(root, rawKey);
    if (!target) return undefined;
    try {
      const deleted = await deleteShadowWorktreeDirectory(root, rawKey);
      return deleted.storageKey;
    } catch (error) {
      console.warn(`[LimCode] Failed to delete shadow worktree: ${rawKey}`, error);
      return undefined;
    }
  }));
  return { deletedStorageKeys: results.filter((key): key is string => !!key) };
}

/** 删除最近 maxAgeDays 天内未活跃的 shadow worktree。 */
export async function cleanupUnusedShadowWorktrees(paths: StoragePaths, maxAgeDays: number): Promise<{ deletedStorageKeys: string[] }> {
  const days = Math.max(1, Math.floor(maxAgeDays));
  const threshold = Date.now() - days * MS_PER_DAY;
  const referencedStorageKeys = await loadReferencedShadowStorageKeys(paths);
  const stats = await collectShadowWorktreeStats(paths);
  const stale = stats
    .filter((stat) => !referencedStorageKeys.has(stat.storageKey))
    .filter((stat) => (stat.lastActiveAt ?? 0) < threshold)
    .map((stat) => stat.storageKey);
  if (stale.length === 0) return { deletedStorageKeys: [] };
  await __shadowCleanupTestHooks.afterCollectStaleCandidates?.(stale);

  const root = paths.checkpointShadowWorktreesRootPath;
  const deletedStorageKeys: string[] = [];
  for (const storageKey of stale) {
    // Keep lock ordering consistent with conversation deletion: skeleton -> worktree.
    const deleted = await withClientStateSkeletonReadTransaction(paths, async () => {
      return withShadowWorktreeLock(root, storageKey, async ({ storageKey: lockedKey, worktreePath }) => {
        const latestReferencedStorageKeys = await loadReferencedShadowStorageKeysUnlocked(paths);
        if (latestReferencedStorageKeys.has(lockedKey)) return false;
        const stat = await fs.stat(worktreePath).catch(() => undefined);
        if (!stat?.isDirectory()) return false;
        const aggregate = await aggregateWorktree(worktreePath);
        if ((aggregate.lastActiveAt ?? 0) >= threshold) return false;
        await fs.rm(worktreePath, { recursive: true, force: true });
        return true;
      });
    });
    if (deleted) deletedStorageKeys.push(storageKey);
  }
  return { deletedStorageKeys };
}

async function loadReferencedShadowStorageKeys(paths: StoragePaths): Promise<Set<string>> {
  return withClientStateSkeletonReadTransaction(paths, () => loadReferencedShadowStorageKeysUnlocked(paths));
}

async function loadReferencedShadowStorageKeysUnlocked(paths: StoragePaths): Promise<Set<string>> {
  const [repositories, checkpoints, repositoryLinks] = await Promise.all([
    loadRecordStore<ShadowRepositoryRecord, string>(paths.shadowRepositoriesRootUri, paths.shadowRepositoriesIndexUri, 'shadowRepository'),
    loadRecordStore<CheckpointRecord, string>(paths.checkpointsRootUri, paths.checkpointsIndexUri, 'checkpoint'),
    loadRecordStore<ConversationCheckpointRepositoryLinkRecord, string>(paths.conversationCheckpointRepositoryLinksRootUri, paths.conversationCheckpointRepositoryLinksIndexUri, 'link')
  ]);

  const repositoryById = new Map<string, ShadowRepositoryRecord>();
  for (const repository of repositories ?? []) {
    if (!shadowWorktreePath(paths.checkpointShadowWorktreesRootPath, repository.storageKey)) continue;
    repositoryById.set(repository.id, repository);
  }

  const referenced = new Set<string>();
  for (const repository of repositoryById.values()) referenced.add(repository.storageKey);
  for (const checkpoint of checkpoints ?? []) {
    const repository = repositoryById.get(checkpoint.shadowRepositoryId);
    if (repository) referenced.add(repository.storageKey);
  }
  for (const link of repositoryLinks ?? []) {
    const repository = repositoryById.get(link.shadowRepositoryId);
    if (repository) referenced.add(repository.storageKey);
  }
  return referenced;
}

async function aggregateWorktree(dir: string): Promise<WorktreeAggregate> {
  const aggregate: WorktreeAggregate = { sizeBytes: 0, fileCount: 0, lastActiveAt: 0 };
  await walk(dir, aggregate, false);
  return aggregate;
}

async function walk(dir: string, aggregate: WorktreeAggregate, insideGit: boolean): Promise<void> {
  for (const entry of await readDirSafe(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, aggregate, insideGit || entry.name === '.git');
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(full).catch(() => undefined);
    if (!stat) continue;
    aggregate.sizeBytes += stat.size;
    if (!insideGit) aggregate.fileCount += 1;
    if (stat.mtimeMs > aggregate.lastActiveAt) aggregate.lastActiveAt = stat.mtimeMs;
  }
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isCandidateWorktreeEntry(entry: Dirent): boolean {
  return entry.isDirectory()
    && entry.name !== SHADOW_WORKTREE_LOCKS_DIR
    && !entry.name.startsWith(SCAN_TEMP_PREFIX)
    && !entry.name.startsWith(RESTORE_TEMP_PREFIX)
    && isShadowWorktreeDirectoryName(entry.name);
}
