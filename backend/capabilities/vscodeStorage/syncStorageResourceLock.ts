import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isFileNotFoundError, isTransientFileBusyError, retryTransientFileOperationSync, sleepSync, unlinkWithRetrySync } from './syncJson';

export interface SyncStorageResourceLockFileMetadata {
  ownerToken: string;
  pid: number;
  createdAt: number;
  resource: string;
}

export interface SyncStorageResourceLockOptions {
  waitMs?: number;
  staleMs?: number;
  pollIntervalMs?: number;
  invalidMetadataWaitMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  lockPath?: string | ((resourcePath: string) => string);
}

interface NormalizedSyncStorageResourceLockOptions {
  waitMs: number;
  staleMs: number;
  pollIntervalMs: number;
  invalidMetadataWaitMs: number;
  maxRetries: number;
  retryDelayMs: number;
  lockPath?: string | ((resourcePath: string) => string);
}

interface AcquiredSyncLockFile {
  lockPath: string;
  metadata: SyncStorageResourceLockFileMetadata;
}

interface LockFileSnapshotBase {
  status: 'missing' | 'empty' | 'invalid' | 'ok';
  stat?: Stats;
}

interface MissingLockFileSnapshot extends LockFileSnapshotBase {
  status: 'missing';
}

interface EmptyLockFileSnapshot extends LockFileSnapshotBase {
  status: 'empty';
  stat: Stats;
}

interface InvalidLockFileSnapshot extends LockFileSnapshotBase {
  status: 'invalid';
  stat: Stats;
  raw: string;
}

interface OkLockFileSnapshot extends LockFileSnapshotBase {
  status: 'ok';
  stat: Stats;
  raw: string;
  metadata: SyncStorageResourceLockFileMetadata;
}

type LockFileSnapshot = MissingLockFileSnapshot | EmptyLockFileSnapshot | InvalidLockFileSnapshot | OkLockFileSnapshot;

const DEFAULT_WAIT_MS = 2_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 20;
const DEFAULT_INVALID_METADATA_WAIT_MS = 100;
const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_RETRY_DELAY_MS = 10;

export function withSyncStorageResourceLock<T>(resourcePath: string, action: () => T, options: SyncStorageResourceLockOptions = {}): T {
  const normalized = normalizeOptions(options);
  const lock = acquireSyncStorageResourceLock(resourcePath, normalized);
  let actionCompleted = false;
  let actionValue: T | undefined;
  let actionError: unknown;

  try {
    actionValue = action();
    actionCompleted = true;
  } catch (error) {
    actionError = error;
  }

  let releaseError: unknown;
  try {
    releaseSyncStorageResourceLock(lock, normalized);
  } catch (error) {
    releaseError = error;
  }

  if (actionError && releaseError) throw combineErrors('Sync storage resource lock action and release both failed.', [actionError, releaseError]);
  if (actionError) throw actionError;
  if (releaseError) throw releaseError;
  if (!actionCompleted) throw new Error('Sync storage resource lock action did not complete.');
  return actionValue as T;
}

function acquireSyncStorageResourceLock(resourcePath: string, options: NormalizedSyncStorageResourceLockOptions): AcquiredSyncLockFile {
  const lockPath = resolveLockPath(resourcePath, options);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const ownerToken = randomUUID();
  const resource = path.resolve(resourcePath);
  const deadline = Date.now() + options.waitMs;

  for (;;) {
    const metadata: SyncStorageResourceLockFileMetadata = {
      ownerToken,
      pid: process.pid,
      createdAt: Date.now(),
      resource
    };
    try {
      createLockFile(lockPath, metadata, options);
      return { lockPath, metadata };
    } catch (error) {
      if (!isAlreadyExistsError(error) && !isTransientFileBusyError(error)) throw error;
      if (recoverExistingLockFile(lockPath, options)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for sync storage resource lock: ${lockPath}`);
      sleepSync(Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseSyncStorageResourceLock(lock: AcquiredSyncLockFile, options: NormalizedSyncStorageResourceLockOptions): void {
  const snapshot = readLockFileSnapshot(lock.lockPath, options);
  if (snapshot.status === 'missing') throw new Error(`Sync storage resource lock disappeared before release: ${lock.lockPath}`);
  if (snapshot.status !== 'ok') throw new Error(`Sync storage resource lock metadata is invalid before release: ${lock.lockPath}`);
  if (snapshot.metadata.ownerToken !== lock.metadata.ownerToken) {
    throw new Error(`Sync storage resource lock owner token mismatch; refusing to delete lock owned by another writer: ${lock.lockPath}`);
  }
  unlinkWithRetrySync(lock.lockPath, false);
}

function normalizeOptions(options: SyncStorageResourceLockOptions): NormalizedSyncStorageResourceLockOptions {
  return {
    waitMs: normalizeNonNegativeInteger(options.waitMs, DEFAULT_WAIT_MS),
    staleMs: normalizeNonNegativeInteger(options.staleMs, DEFAULT_STALE_MS),
    pollIntervalMs: Math.max(1, normalizeNonNegativeInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)),
    invalidMetadataWaitMs: normalizeNonNegativeInteger(options.invalidMetadataWaitMs, DEFAULT_INVALID_METADATA_WAIT_MS),
    maxRetries: Math.max(1, normalizeNonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES)),
    retryDelayMs: normalizeNonNegativeInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
    lockPath: options.lockPath
  };
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function resolveLockPath(resourcePath: string, options: NormalizedSyncStorageResourceLockOptions): string {
  const resolvedResourcePath = path.resolve(resourcePath);
  const lockPath = typeof options.lockPath === 'function'
    ? options.lockPath(resolvedResourcePath)
    : options.lockPath ?? `${resolvedResourcePath}.lock`;
  if (!lockPath || !lockPath.trim()) throw new Error(`Sync storage resource lock path is empty: ${resolvedResourcePath}`);
  return path.resolve(lockPath);
}

function createLockFile(lockPath: string, metadata: SyncStorageResourceLockFileMetadata, options: NormalizedSyncStorageResourceLockOptions): void {
  const fd = fs.openSync(lockPath, 'wx');
  let writeError: unknown;
  let closeError: unknown;
  try {
    fs.writeFileSync(fd, `${JSON.stringify(metadata)}\n`, 'utf8');
  } catch (error) {
    writeError = error;
  }

  try {
    retryTransientFileOperationSync(() => fs.closeSync(fd), options.maxRetries, options.retryDelayMs);
  } catch (error) {
    closeError = error;
  }

  if (!writeError && !closeError) return;

  let cleanupError: unknown;
  try {
    unlinkWithRetrySync(lockPath, true);
  } catch (error) {
    cleanupError = error;
  }
  throw combineErrors(`Failed to create sync storage resource lock: ${lockPath}`, [writeError, closeError, cleanupError]);
}

function recoverExistingLockFile(lockPath: string, options: NormalizedSyncStorageResourceLockOptions): boolean {
  const snapshot = readLockFileSnapshot(lockPath, options);
  if (snapshot.status === 'missing') return true;

  if (snapshot.status === 'empty' || snapshot.status === 'invalid') {
    const ageMs = Math.max(0, Date.now() - lockFileTimestamp(snapshot.stat));
    if (ageMs < options.invalidMetadataWaitMs) return false;
    unlinkWithRetrySync(lockPath, true);
    return true;
  }

  const ageMs = Math.max(0, Date.now() - snapshot.metadata.createdAt);
  if (ageMs < options.staleMs) return false;
  unlinkWithRetrySync(lockPath, true);
  return true;
}

function readLockFileSnapshot(lockPath: string, options: NormalizedSyncStorageResourceLockOptions): LockFileSnapshot {
  let stat: Stats;
  try {
    stat = retryTransientFileOperationSync(() => fs.statSync(lockPath), options.maxRetries, options.retryDelayMs);
  } catch (error) {
    if (isFileNotFoundError(error)) return { status: 'missing' };
    throw error;
  }

  let raw: string;
  try {
    raw = retryTransientFileOperationSync(() => fs.readFileSync(lockPath, 'utf8'), options.maxRetries, options.retryDelayMs);
  } catch (error) {
    if (isFileNotFoundError(error)) return { status: 'missing' };
    throw error;
  }

  if (!raw.trim()) return { status: 'empty', stat };
  try {
    const metadata = JSON.parse(raw) as Partial<SyncStorageResourceLockFileMetadata> | undefined;
    if (!isLockFileMetadata(metadata)) return { status: 'invalid', stat, raw };
    return { status: 'ok', stat, raw, metadata };
  } catch {
    return { status: 'invalid', stat, raw };
  }
}

function isLockFileMetadata(value: unknown): value is SyncStorageResourceLockFileMetadata {
  const metadata = value as Partial<SyncStorageResourceLockFileMetadata> | undefined;
  return !!metadata
    && typeof metadata.ownerToken === 'string'
    && !!metadata.ownerToken.trim()
    && typeof metadata.pid === 'number'
    && Number.isSafeInteger(metadata.pid)
    && metadata.pid > 0
    && typeof metadata.createdAt === 'number'
    && Number.isFinite(metadata.createdAt)
    && metadata.createdAt > 0
    && typeof metadata.resource === 'string'
    && !!metadata.resource.trim();
}

function lockFileTimestamp(stat: Stats): number {
  return Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0 ? stat.mtimeMs : stat.ctimeMs;
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'EEXIST';
}

function combineErrors(message: string, errors: readonly unknown[]): Error {
  const present = errors.filter((error) => error !== undefined);
  if (present.length === 1 && present[0] instanceof Error) return present[0];
  const error = new Error(message);
  (error as Error & { errors?: unknown[] }).errors = present;
  return error;
}
