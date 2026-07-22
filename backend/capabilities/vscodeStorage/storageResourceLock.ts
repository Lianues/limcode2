import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isFileNotFoundError } from './json';

export interface StorageResourceLockFileMetadata {
  ownerToken: string;
  pid: number;
  createdAt: number;
  heartbeatAt: number;
  resource: string;
  resourceFsPath?: string;
}

export interface StorageResourceLockOptions {
  waitMs?: number;
  staleMs?: number;
  lockPath?: string | ((resourceUri: vscode.Uri) => string);
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  invalidMetadataWaitMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface StorageResourceLock {
  readonly resourceUri: vscode.Uri;
  readonly resourceKey: string;
  readonly lockPath?: string;
  readonly metadata?: StorageResourceLockFileMetadata;
  readonly heartbeatErrors?: readonly unknown[];
  release(): Promise<void>;
}

interface NormalizedStorageResourceLockOptions {
  waitMs: number;
  staleMs: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  invalidMetadataWaitMs: number;
  maxRetries: number;
  retryDelayMs: number;
  lockPath?: string | ((resourceUri: vscode.Uri) => string);
}

interface AcquiredLockFile {
  lockPath: string;
  metadata: StorageResourceLockFileMetadata;
  heartbeat: LockHeartbeatController;
}

interface LockHeartbeatController {
  readonly errors: readonly unknown[];
  stop(): Promise<void>;
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
  metadata: StorageResourceLockFileMetadata;
}

type LockFileSnapshot = MissingLockFileSnapshot | EmptyLockFileSnapshot | InvalidLockFileSnapshot | OkLockFileSnapshot;

const DEFAULT_WAIT_MS = 5 * 60_000;
const DEFAULT_STALE_MS = 30 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_INVALID_METADATA_WAIT_MS = 150;
const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_RETRY_DELAY_MS = 15;

const inProcessLockQueues = new Map<string, Promise<void>>();
let heartbeatWriteSequence = 0;

export async function withStorageResourceLock<T>(resourceUri: vscode.Uri, action: () => Promise<T>, options: StorageResourceLockOptions = {}): Promise<T> {
  const lock = await acquireStorageResourceLock(resourceUri, options);
  let actionCompleted = false;
  let actionValue: T | undefined;
  let actionError: unknown;

  try {
    actionValue = await action();
    actionCompleted = true;
  } catch (error) {
    actionError = error;
  }

  let releaseError: unknown;
  try {
    await lock.release();
  } catch (error) {
    releaseError = error;
  }

  if (actionError && releaseError) throw combineErrors('Storage resource lock action and release both failed.', [actionError, releaseError]);
  if (actionError) throw actionError;
  if (releaseError) throw releaseError;
  if (!actionCompleted) throw new Error('Storage resource lock action did not complete.');
  return actionValue as T;
}

export async function acquireStorageResourceLock(resourceUri: vscode.Uri, options: StorageResourceLockOptions = {}): Promise<StorageResourceLock> {
  const normalized = normalizeOptions(options);
  const resourceKey = getResourceKey(resourceUri);
  const releaseInProcessTurn = await enterInProcessLockQueue(resourceKey);
  let acquiredFileLock: AcquiredLockFile | undefined;
  let inProcessReleased = false;

  const releaseInProcess = () => {
    if (inProcessReleased) return;
    inProcessReleased = true;
    releaseInProcessTurn();
  };

  try {
    if (shouldUseLockFile(resourceUri, normalized)) {
      acquiredFileLock = await acquireLockFile(resourceUri, normalized);
    }
  } catch (error) {
    releaseInProcess();
    throw error;
  }

  let released = false;
  return {
    resourceUri,
    resourceKey,
    lockPath: acquiredFileLock?.lockPath,
    metadata: acquiredFileLock?.metadata,
    get heartbeatErrors() { return acquiredFileLock?.heartbeat.errors; },
    async release(): Promise<void> {
      if (released) return;
      try {
        if (acquiredFileLock) await releaseLockFile(acquiredFileLock, normalized);
        released = true;
      } finally {
        releaseInProcess();
      }
    }
  };
}

function normalizeOptions(options: StorageResourceLockOptions): NormalizedStorageResourceLockOptions {
  const staleMs = normalizeNonNegativeInteger(options.staleMs, DEFAULT_STALE_MS);
  return {
    waitMs: normalizeNonNegativeInteger(options.waitMs, DEFAULT_WAIT_MS),
    staleMs,
    pollIntervalMs: Math.max(1, normalizeNonNegativeInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)),
    heartbeatIntervalMs: Math.max(1, normalizeNonNegativeInteger(options.heartbeatIntervalMs, defaultHeartbeatIntervalMs(staleMs))),
    invalidMetadataWaitMs: normalizeNonNegativeInteger(options.invalidMetadataWaitMs, DEFAULT_INVALID_METADATA_WAIT_MS),
    maxRetries: Math.max(1, normalizeNonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES)),
    retryDelayMs: normalizeNonNegativeInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
    lockPath: options.lockPath
  };
}

function defaultHeartbeatIntervalMs(staleMs: number): number {
  if (staleMs <= 1) return 1;
  return Math.max(1, Math.min(DEFAULT_MAX_HEARTBEAT_INTERVAL_MS, Math.floor(staleMs / 3)));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function shouldUseLockFile(resourceUri: vscode.Uri, options: NormalizedStorageResourceLockOptions): boolean {
  return resourceUri.scheme === 'file' || options.lockPath !== undefined;
}

async function enterInProcessLockQueue(resourceKey: string): Promise<() => void> {
  const previous = inProcessLockQueues.get(resourceKey) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const queue = previous.catch(() => undefined).then(() => turn);
  inProcessLockQueues.set(resourceKey, queue);

  await previous.catch(() => undefined);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseTurn();
    if (inProcessLockQueues.get(resourceKey) === queue) inProcessLockQueues.delete(resourceKey);
  };
}

async function acquireLockFile(resourceUri: vscode.Uri, options: NormalizedStorageResourceLockOptions): Promise<AcquiredLockFile> {
  const lockPath = resolveLockPath(resourceUri, options);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const ownerToken = randomUUID();
  const resource = getResourceKey(resourceUri);
  const resourceFsPath = typeof resourceUri.fsPath === 'string' && resourceUri.fsPath ? resourceUri.fsPath : undefined;
  const deadline = Date.now() + options.waitMs;

  for (;;) {
    const now = Date.now();
    const metadata: StorageResourceLockFileMetadata = {
      ownerToken,
      pid: process.pid,
      createdAt: now,
      heartbeatAt: now,
      resource,
      ...(resourceFsPath ? { resourceFsPath } : {})
    };
    try {
      await createLockFile(lockPath, metadata, options);
      return { lockPath, metadata, heartbeat: createLockHeartbeat(lockPath, metadata, options) };
    } catch (error) {
      if (!isAlreadyExistsError(error) && !isTransientFileBusyError(error)) throw error;
      if (await recoverExistingLockFile(lockPath, options)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for storage resource lock: ${lockPath}`);
      }
      await delay(Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function resolveLockPath(resourceUri: vscode.Uri, options: NormalizedStorageResourceLockOptions): string {
  const lockPath = typeof options.lockPath === 'function'
    ? options.lockPath(resourceUri)
    : options.lockPath ?? `${resourceUri.fsPath}.lock`;
  if (!lockPath || !lockPath.trim()) throw new Error(`Storage resource lock path is empty: ${getResourceKey(resourceUri)}`);
  return path.resolve(lockPath);
}

async function createLockFile(lockPath: string, metadata: StorageResourceLockFileMetadata, options: NormalizedStorageResourceLockOptions): Promise<void> {
  const handle = await fs.open(lockPath, 'wx');
  let writeError: unknown;
  let closeError: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
  } catch (error) {
    writeError = error;
  }

  try {
    await closeWithRetry(handle, options);
  } catch (error) {
    closeError = error;
  }

  if (!writeError && !closeError) return;

  let cleanupError: unknown;
  try {
    await removeLockFileWithRetry(lockPath, options, true);
  } catch (error) {
    cleanupError = error;
  }
  throw combineErrors(`Failed to create storage resource lock: ${lockPath}`, [writeError, closeError, cleanupError]);
}

async function releaseLockFile(lock: AcquiredLockFile, options: NormalizedStorageResourceLockOptions): Promise<void> {
  await lock.heartbeat.stop();

  let releaseError: unknown;
  try {
    const snapshot = await readLockFileSnapshot(lock.lockPath, options);
    if (snapshot.status === 'missing') throw new Error(`Storage resource lock disappeared before release: ${lock.lockPath}`);
    if (snapshot.status !== 'ok') throw new Error(`Storage resource lock metadata is invalid before release: ${lock.lockPath}`);
    if (snapshot.metadata.ownerToken !== lock.metadata.ownerToken) {
      throw new Error(`Storage resource lock owner token mismatch; refusing to delete lock owned by another writer: ${lock.lockPath}`);
    }
    await removeLockFileWithRetry(lock.lockPath, options, false);
  } catch (error) {
    releaseError = error;
  }

  const heartbeatError = lock.heartbeat.errors.length > 0
    ? combineErrors(`Storage resource lock heartbeat failed ${lock.heartbeat.errors.length} time(s): ${lock.lockPath}`, lock.heartbeat.errors)
    : undefined;
  if (releaseError && heartbeatError) throw combineErrors(`Storage resource lock release and heartbeat both failed: ${lock.lockPath}`, [releaseError, heartbeatError]);
  if (releaseError) throw releaseError;
  // A transient heartbeat failure does not invalidate a successfully verified
  // owner-token release. The heartbeat path already logs diagnostics; turning a
  // completed storage action into a retry here would create duplicate writes.
}

async function recoverExistingLockFile(lockPath: string, options: NormalizedStorageResourceLockOptions): Promise<boolean> {
  const snapshot = await readLockFileSnapshot(lockPath, options);
  if (snapshot.status === 'missing') return true;

  if (snapshot.status === 'empty' || snapshot.status === 'invalid') {
    const ageMs = Math.max(0, Date.now() - lockFileTimestamp(snapshot.stat));
    if (ageMs < options.invalidMetadataWaitMs) return false;
    await removeLockFileWithRetry(lockPath, options, true);
    return true;
  }

  const heartbeatAgeMs = Math.max(0, Date.now() - snapshot.metadata.heartbeatAt);
  const ownerAlive = processIsAlive(snapshot.metadata.pid);
  // 新格式先用 heartbeatAt 判定 stale，再结合 owner pid 存活状态。
  // heartbeat 仍新鲜或 owner pid 仍存活时都不抢占；长 action 会持续刷新 heartbeat，避免 createdAt 超时误删活锁。
  if (heartbeatAgeMs < options.staleMs || ownerAlive) return false;
  await removeLockFileWithRetry(lockPath, options, true);
  return true;
}

async function readLockFileSnapshot(lockPath: string, options: NormalizedStorageResourceLockOptions): Promise<LockFileSnapshot> {
  let stat: Stats;
  try {
    stat = await retryTransientFileOperation(() => fs.stat(lockPath), options);
  } catch (error) {
    if (isFileNotFoundError(error)) return { status: 'missing' };
    throw error;
  }

  let raw: string;
  try {
    raw = await retryTransientFileOperation(() => fs.readFile(lockPath, 'utf8'), options);
  } catch (error) {
    if (isFileNotFoundError(error)) return { status: 'missing' };
    throw error;
  }

  if (!raw.trim()) return { status: 'empty', stat };
  try {
    const metadata = JSON.parse(raw) as Partial<StorageResourceLockFileMetadata> | undefined;
    if (!isLockFileMetadata(metadata)) return { status: 'invalid', stat, raw };
    return { status: 'ok', stat, raw, metadata };
  } catch {
    return { status: 'invalid', stat, raw };
  }
}

function isLockFileMetadata(value: unknown): value is StorageResourceLockFileMetadata {
  const metadata = value as Partial<StorageResourceLockFileMetadata> | undefined;
  return !!metadata
    && typeof metadata.ownerToken === 'string'
    && !!metadata.ownerToken.trim()
    && typeof metadata.pid === 'number'
    && Number.isSafeInteger(metadata.pid)
    && metadata.pid > 0
    && typeof metadata.createdAt === 'number'
    && Number.isFinite(metadata.createdAt)
    && metadata.createdAt > 0
    && typeof metadata.heartbeatAt === 'number'
    && Number.isFinite(metadata.heartbeatAt)
    && metadata.heartbeatAt > 0
    && typeof metadata.resource === 'string'
    && !!metadata.resource.trim()
    && (metadata.resourceFsPath === undefined || typeof metadata.resourceFsPath === 'string');
}

function createLockHeartbeat(lockPath: string, metadata: StorageResourceLockFileMetadata, options: NormalizedStorageResourceLockOptions): LockHeartbeatController {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const errors: unknown[] = [];

  const runHeartbeat = () => {
    if (stopped || inFlight) return;
    inFlight = writeLockHeartbeat(lockPath, metadata, options)
      .catch((error) => {
        errors.push(error);
        console.warn(`[LimCode] Failed to refresh storage resource lock heartbeat: ${lockPath}`, error);
      })
      .finally(() => { inFlight = undefined; });
  };

  const timer = setInterval(runHeartbeat, options.heartbeatIntervalMs);
  timer.unref?.();

  return {
    get errors() { return errors; },
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
    }
  };
}

async function writeLockHeartbeat(lockPath: string, metadata: StorageResourceLockFileMetadata, options: NormalizedStorageResourceLockOptions): Promise<void> {
  const snapshot = await readLockFileSnapshot(lockPath, options);
  if (snapshot.status === 'missing') throw new Error(`Storage resource lock disappeared before heartbeat: ${lockPath}`);
  if (snapshot.status !== 'ok') throw new Error(`Storage resource lock metadata is invalid before heartbeat: ${lockPath}`);
  if (snapshot.metadata.ownerToken !== metadata.ownerToken) {
    throw new Error(`Storage resource lock owner token mismatch before heartbeat: ${lockPath}`);
  }
  const heartbeatAt = Date.now();
  const next: StorageResourceLockFileMetadata = { ...snapshot.metadata, heartbeatAt };
  await writeLockFileAtomically(lockPath, next, options);
  metadata.heartbeatAt = heartbeatAt;
}

async function writeLockFileAtomically(lockPath: string, metadata: StorageResourceLockFileMetadata, options: NormalizedStorageResourceLockOptions): Promise<void> {
  const tempPath = `${lockPath}.${process.pid}.${Date.now()}.${heartbeatWriteSequence++}.heartbeat.tmp`;
  try {
    await retryTransientFileOperation(() => fs.writeFile(tempPath, `${JSON.stringify(metadata)}\n`, 'utf8'), options);
    await retryTransientFileOperation(() => fs.rename(tempPath, lockPath), options);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function closeWithRetry(handle: fs.FileHandle, options: NormalizedStorageResourceLockOptions): Promise<void> {
  await retryTransientFileOperation(() => handle.close(), options);
}

async function removeLockFileWithRetry(lockPath: string, options: NormalizedStorageResourceLockOptions, ignoreMissing: boolean): Promise<void> {
  await retryTransientFileOperation(async () => {
    try {
      await fs.rm(lockPath, { force: false });
    } catch (error) {
      if (ignoreMissing && isFileNotFoundError(error)) return;
      throw error;
    }
  }, options);
}

async function retryTransientFileOperation<T>(action: () => Promise<T>, options: NormalizedStorageResourceLockOptions): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= options.maxRetries || !isTransientFileBusyError(error)) throw error;
      await delay(options.retryDelayMs * attempt);
    }
  }
}

function lockFileTimestamp(stat: Stats): number {
  return Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0 ? stat.mtimeMs : stat.ctimeMs;
}


function getResourceKey(uri: vscode.Uri): string {
  try {
    return uri.toString(true);
  } catch {
    return `${uri.scheme}:${uri.fsPath}`;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'EEXIST';
}

function isTransientFileBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === 'EPERM';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function combineErrors(message: string, errors: readonly unknown[]): Error {
  const present = errors.filter((error) => error !== undefined);
  if (present.length === 1 && present[0] instanceof Error) return present[0];
  const error = new Error(message);
  (error as Error & { errors?: unknown[] }).errors = present;
  return error;
}
