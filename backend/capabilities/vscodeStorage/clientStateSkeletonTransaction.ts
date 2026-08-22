import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ClientState } from '../../../shared/protocol';
import { createEmptyClientState } from '../../../shared/clientStateSchema';
import { stripConversationFromClientState } from '../../utils/clientStateConversationCascade';
import { STORAGE_VERSION } from './constants';
import type { StoragePaths } from './clientStateStore';
import {
  applyClientStateSkeletonStorePatch,
  createClientStateSkeletonPatch,
  isEmptyClientStateSkeletonPatch,
  type ClientStateSkeletonPatch
} from './clientStateSkeletonPatch';
import {
  assignSkeletonRecordsToState,
  CLIENT_STATE_SKELETON_STORES,
  CLIENT_STATE_SKELETON_STORE_KEYS,
  type ClientStateSkeletonRecord,
  type ClientStateSkeletonStoreKey
} from './clientStateSkeletonStores';
import { isFileNotFoundError, readJsonStrict, writeJson, writeJsonAtomic } from './json';
import {
  loadRecordStoreGeneration,
  prepareRecordStoreGeneration,
  type RecordStoreGenerationRef
} from './recordStore';
import { withStorageResourceLock } from './storageResourceLock';
import {
  cleanupInactiveStorageGenerations,
  createStorageGenerationId,
  getStorageGenerationRootUri,
  isSafeStorageGenerationId,
  STANDARD_STORAGE_GENERATION_RETENTION_BUCKETS_MS,
  STORAGE_GENERATIONS_DIR
} from './storageGeneration';
import { createStorageRevision } from './storageRevision';
import { deleteStorageUri, ensureStorageDirectory, readStorageDirectory } from './storageFs';

const CURRENT_POINTER_FILE = 'current.json';
const PREVIOUS_POINTER_FILE = 'previous.json';
const SNAPSHOTS_DIR = 'snapshots';
const PREPARING_DIR = 'preparing';
const PREPARED_DIR = 'prepared';
const PINS_DIR = 'pins';
const TRANSACTION_RESOURCE = 'transaction';
const PIN_STALE_MS = 60 * 60_000;
const PREPARE_MARKER_STALE_MS = 60 * 60_000;
const SKELETON_LOCK_STALE_MS = 10_000;
const SKELETON_LOCK_WAIT_MS = 2 * 60_000;

interface ClientStateSkeletonPointerFile {
  kind: 'clientStateSkeleton.current';
  schemaVersion: typeof STORAGE_VERSION;
  snapshotId: string;
  manifestRevision: string;
  publishedAt: string;
}

export interface ClientStateSkeletonSnapshotManifest {
  kind: 'clientStateSkeleton.snapshot';
  schemaVersion: typeof STORAGE_VERSION;
  snapshotId: string;
  parentSnapshotId?: string;
  createdAt: string;
  stores: Record<ClientStateSkeletonStoreKey, RecordStoreGenerationRef>;
}

interface ClientStateSkeletonPreparingMarker {
  kind: 'clientStateSkeleton.preparing';
  schemaVersion: typeof STORAGE_VERSION;
  snapshotId: string;
  parentSnapshotId?: string;
  ownerPid: number;
  startedAt: number;
}

interface ClientStateSkeletonPreparedMarker {
  kind: 'clientStateSkeleton.prepared';
  schemaVersion: typeof STORAGE_VERSION;
  snapshotId: string;
  parentSnapshotId?: string;
  manifestRevision: string;
  preparedAt: string;
}

interface ClientStateSkeletonPinFile {
  kind: 'clientStateSkeleton.pin';
  schemaVersion: typeof STORAGE_VERSION;
  pinId: string;
  snapshotId: string;
  ownerId: string;
  pid: number;
  createdAt: number;
  heartbeatAt: number;
}

export interface PinnedClientStateSkeletonSnapshot {
  pinId: string;
  snapshotId: string;
  manifestRevision: string;
  manifest: ClientStateSkeletonSnapshotManifest;
}

export interface ClientStateSkeletonCommitResult {
  snapshotId: string;
  manifestRevision: string;
  changedStores: ClientStateSkeletonStoreKey[];
}

export interface OpenClientStateSkeletonSnapshotOptions {
  /**
   * 仅用于可由其它 canonical 数据重新生成的新派生 skeleton。首次提交若在 current
   * pointer 发布前中断，清理与 preparing marker 完全对应的未发布 generations。
   */
  recoverAbandonedInitialCommit?: boolean;
}

interface LoadedSkeletonSnapshot {
  pointer: ClientStateSkeletonPointerFile;
  manifest: ClientStateSkeletonSnapshotManifest;
}

export interface ClientStateSkeletonTransactionTestHooks {
  afterPhase?: (phase: 'storesPrepared' | 'snapshotWritten' | 'preparedWritten' | 'previousWritten' | 'currentWritten', snapshotId: string) => void | Promise<void>;
}

export const __clientStateSkeletonTransactionTestHooks: ClientStateSkeletonTransactionTestHooks = {};

/**
 * 为 startup/deferred 打开同一 immutable snapshot 并创建持久 pin。锁只覆盖 pointer 解析与
 * pin 发布，真正的 40-store 读取不持写锁，因此其它 Extension Host 可继续提交。
 */
export async function openClientStateSkeletonSnapshot(
  paths: StoragePaths,
  ownerId: string,
  options: OpenClientStateSkeletonSnapshotOptions = {}
): Promise<PinnedClientStateSkeletonSnapshot | undefined> {
  return withSkeletonCoordinatorLock(paths, async () => {
    if (options.recoverAbandonedInitialCommit) await recoverAbandonedInitialCommit(paths);
    const active = await loadActiveSnapshotWithWholeFallback(paths);
    if (!active) return undefined;
    const pinId = randomUUID();
    const now = Date.now();
    const pin: ClientStateSkeletonPinFile = {
      kind: 'clientStateSkeleton.pin',
      schemaVersion: STORAGE_VERSION,
      pinId,
      snapshotId: active.manifest.snapshotId,
      ownerId,
      pid: process.pid,
      createdAt: now,
      heartbeatAt: now
    };
    await ensureStorageDirectory(pinsRootUri(paths));
    await writeJsonAtomic(pinUri(paths, pinId), pin);
    return {
      pinId,
      snapshotId: active.manifest.snapshotId,
      manifestRevision: active.pointer.manifestRevision,
      manifest: cloneManifest(active.manifest)
    };
  });
}

export async function refreshClientStateSkeletonPin(paths: StoragePaths, pin: PinnedClientStateSkeletonSnapshot): Promise<void> {
  return withSkeletonCoordinatorLock(paths, async () => {
    const uri = pinUri(paths, pin.pinId);
    const result = await readJsonStrict<unknown>(uri);
    if (result.status !== 'ok') throw new Error(`Client-state skeleton pin is unavailable: ${uri.fsPath}`);
    const current = parsePin(result.value, uri);
    if (current.snapshotId !== pin.snapshotId) throw new Error(`Client-state skeleton pin snapshot mismatch: ${pin.pinId}`);
    await writeJsonAtomic(uri, { ...current, heartbeatAt: Date.now() } satisfies ClientStateSkeletonPinFile);
  });
}

export async function releaseClientStateSkeletonSnapshot(
  paths: StoragePaths,
  pin: PinnedClientStateSkeletonSnapshot
): Promise<void> {
  return withSkeletonCoordinatorLock(paths, async () => {
    try {
      await deleteStorageUri(pinUri(paths, pin.pinId), { useTrash: false });
    } catch {
      // release 幂等；GC 也可能已经清理 stale pin。
    }
  });
}

/**
 * 在最新 committed snapshot 上应用 per-record patch，先准备各领域不可变 generation，
 * 最后只原子发布一个 coordinator current pointer。
 */
export async function commitClientStateSkeletonPatch(
  paths: StoragePaths,
  patch: ClientStateSkeletonPatch
): Promise<ClientStateSkeletonCommitResult> {
  return withSkeletonCoordinatorLock(paths, () => commitClientStateSkeletonPatchUnlocked(paths, patch));
}

/**
 * Conversation 删除是显式领域 mutation：在 coordinator 锁内读取最新 union 后执行 cascade，
 * 因而也会删除本窗口从未 hydrate 的外部 Link，不依赖陈旧本地全量快照。
 */
export async function commitClientStateSkeletonConversationDeletion(
  paths: StoragePaths,
  conversationId: string,
  additionalRunIds: Iterable<string> = []
): Promise<ClientStateSkeletonCommitResult | undefined> {
  return withSkeletonCoordinatorLock(paths, async () => {
    const active = await loadActiveSnapshotWithWholeFallback(paths);
    if (!active) return undefined;
    const current = createEmptyClientState();
    const loaded = await Promise.all(CLIENT_STATE_SKELETON_STORES.map(async (store) => ({
      key: store.key,
      records: (await loadRecordStoreGeneration<ClientStateSkeletonRecord, string>(
        store.root(paths), active.manifest.stores[store.key], store.recordKey, store.key
      )).records
    })));
    for (const store of loaded) assignSkeletonRecordsToState(current, store.key, store.records);
    const next = stripConversationFromClientState(current, conversationId, { additionalRunIds });
    const patch = createClientStateSkeletonPatch(current, next);
    return commitClientStateSkeletonPatchUnlocked(paths, patch, active);
  });
}

async function commitClientStateSkeletonPatchUnlocked(
  paths: StoragePaths,
  patch: ClientStateSkeletonPatch,
  knownActive?: LoadedSkeletonSnapshot
): Promise<ClientStateSkeletonCommitResult> {
  const active = knownActive ?? await loadActiveSnapshotWithWholeFallback(paths);
  if (active && isEmptyClientStateSkeletonPatch(patch)) {
    return {
      snapshotId: active.manifest.snapshotId,
      manifestRevision: active.pointer.manifestRevision,
      changedStores: []
    };
  }

  const nextRecords = new Map<ClientStateSkeletonStoreKey, ClientStateSkeletonRecord[]>();
  const changedStores: ClientStateSkeletonStoreKey[] = [];

  // 先完成全部 CAS/冲突检查；任何 generation 文件写入前就失败。
  for (const store of CLIENT_STATE_SKELETON_STORES) {
    const storePatch = patch[store.key];
    if (!storePatch && active) continue;
    const currentRecords = active
      ? (await loadRecordStoreGeneration<ClientStateSkeletonRecord, string>(
          store.root(paths),
          active.manifest.stores[store.key],
          store.recordKey,
          store.key
        )).records
      : [];
    const applied = storePatch
      ? applyClientStateSkeletonStorePatch(store.key, currentRecords, storePatch)
      : { records: currentRecords, changed: false };
    nextRecords.set(store.key, applied.records);
    if (!active || applied.changed) changedStores.push(store.key);
  }

  if (active && changedStores.length === 0) {
    return {
      snapshotId: active.manifest.snapshotId,
      manifestRevision: active.pointer.manifestRevision,
      changedStores: []
    };
  }

  const snapshotId = createStorageGenerationId();
  const preparing: ClientStateSkeletonPreparingMarker = {
    kind: 'clientStateSkeleton.preparing',
    schemaVersion: STORAGE_VERSION,
    snapshotId,
    ...(active ? { parentSnapshotId: active.manifest.snapshotId } : {}),
    ownerPid: process.pid,
    startedAt: Date.now()
  };
  await ensureStorageDirectory(preparingRootUri(paths));
  await writeJson(preparingUri(paths, snapshotId), preparing);

  const stores = active ? cloneStoreRefs(active.manifest.stores) : {} as Record<ClientStateSkeletonStoreKey, RecordStoreGenerationRef>;
  await Promise.all(changedStores.map(async (key) => {
    const store = descriptorFor(key);
    const records = nextRecords.get(key) ?? [];
    stores[key] = await prepareRecordStoreGeneration(
      store.root(paths),
      records,
      store.recordKey,
      store.label,
      { storeKey: key, generation: snapshotId }
    );
  }));
  await __clientStateSkeletonTransactionTestHooks.afterPhase?.('storesPrepared', snapshotId);

  assertExactStoreRefs(stores);
  const manifest: ClientStateSkeletonSnapshotManifest = {
    kind: 'clientStateSkeleton.snapshot',
    schemaVersion: STORAGE_VERSION,
    snapshotId,
    ...(active ? { parentSnapshotId: active.manifest.snapshotId } : {}),
    createdAt: new Date().toISOString(),
    stores
  };
  const manifestRevision = createStorageRevision(manifest);
  await ensureStorageDirectory(snapshotsRootUri(paths));
  await writeJson(snapshotManifestUri(paths, snapshotId), manifest);
  await __clientStateSkeletonTransactionTestHooks.afterPhase?.('snapshotWritten', snapshotId);

  const prepared: ClientStateSkeletonPreparedMarker = {
    kind: 'clientStateSkeleton.prepared',
    schemaVersion: STORAGE_VERSION,
    snapshotId,
    ...(active ? { parentSnapshotId: active.manifest.snapshotId } : {}),
    manifestRevision,
    preparedAt: new Date().toISOString()
  };
  await ensureStorageDirectory(preparedRootUri(paths));
  await writeJson(preparedUri(paths, snapshotId), prepared);
  await __clientStateSkeletonTransactionTestHooks.afterPhase?.('preparedWritten', snapshotId);

  if (active) {
    await writeJson(previousPointerUri(paths), active.pointer);
    await __clientStateSkeletonTransactionTestHooks.afterPhase?.('previousWritten', snapshotId);
  }

  const pointer: ClientStateSkeletonPointerFile = {
    kind: 'clientStateSkeleton.current',
    schemaVersion: STORAGE_VERSION,
    snapshotId,
    manifestRevision,
    publishedAt: new Date().toISOString()
  };
  try {
    await writeJson(currentPointerUri(paths), pointer);
  } catch (error) {
    const published = await tryLoadPointer(currentPointerUri(paths));
    if (published?.snapshotId !== snapshotId || published.manifestRevision !== manifestRevision) throw error;
  }
  await __clientStateSkeletonTransactionTestHooks.afterPhase?.('currentWritten', snapshotId);

  try {
    await deleteStorageUri(preparedUri(paths, snapshotId), { useTrash: false });
  } catch {
    // current 已发布；marker/GC 清理失败不能把 committed transaction 报成失败。
  }
  try {
    await deleteStorageUri(preparingUri(paths, snapshotId), { useTrash: false });
  } catch {
    // current 已发布；marker/GC 清理失败不能把 committed transaction 报成失败。
  }
  try {
    await garbageCollectSkeletonUnlocked(paths);
  } catch (error) {
    console.warn('[LimCode] Client-state skeleton committed, but generation GC failed closed.', error);
  }
  return { snapshotId, manifestRevision, changedStores };
}


export async function loadPinnedClientStateSkeletonStore(
  paths: StoragePaths,
  pin: PinnedClientStateSkeletonSnapshot,
  key: ClientStateSkeletonStoreKey
): Promise<ClientStateSkeletonRecord[]> {
  const store = descriptorFor(key);
  const ref = pin.manifest.stores[key];
  if (!ref) throw new Error(`Pinned client-state skeleton is missing store ref: ${key}`);
  return (await loadRecordStoreGeneration<ClientStateSkeletonRecord, string>(
    store.root(paths), ref, store.recordKey, key
  )).records;
}

export async function withLockedClientStateSkeletonSnapshot<T>(
  paths: StoragePaths,
  action: (snapshot: PinnedClientStateSkeletonSnapshot | undefined) => Promise<T>
): Promise<T> {
  return withSkeletonCoordinatorLock(paths, async () => {
    const active = await loadActiveSnapshotWithWholeFallback(paths);
    const snapshot = active ? {
      pinId: '',
      snapshotId: active.manifest.snapshotId,
      manifestRevision: active.pointer.manifestRevision,
      manifest: cloneManifest(active.manifest)
    } satisfies PinnedClientStateSkeletonSnapshot : undefined;
    return action(snapshot);
  });
}

export async function garbageCollectClientStateSkeleton(paths: StoragePaths): Promise<void> {
  return withSkeletonCoordinatorLock(paths, () => garbageCollectSkeletonUnlocked(paths));
}

async function garbageCollectSkeletonUnlocked(paths: StoragePaths): Promise<void> {
  const now = Date.now();
  const retainedSnapshots = new Set<string>();
  const current = await loadSnapshotFromPointerFile(paths, currentPointerUri(paths), true);
  const previous = await loadSnapshotFromPointerFile(paths, previousPointerUri(paths), true);
  if (current) retainedSnapshots.add(current.manifest.snapshotId);
  if (previous) retainedSnapshots.add(previous.manifest.snapshotId);

  for (const [name, type] of await readDirectoryOrEmpty(pinsRootUri(paths))) {
    if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
    const uri = vscode.Uri.joinPath(pinsRootUri(paths), name);
    const result = await readJsonStrict<unknown>(uri);
    if (result.status !== 'ok') throw new Error(`Unable to validate client-state skeleton pin before GC: ${uri.fsPath}`);
    const pin = parsePin(result.value, uri);
    if (now - pin.heartbeatAt > PIN_STALE_MS) {
      await deleteStorageUri(uri, { useTrash: false });
      continue;
    }
    retainedSnapshots.add(pin.snapshotId);
  }

  const protectedMarkers = await scanFreshTransactionMarkers(paths, now);
  for (const snapshotId of protectedMarkers.retainedSnapshotIds) retainedSnapshots.add(snapshotId);

  const retainedManifests = new Map<string, ClientStateSkeletonSnapshotManifest>();
  for (const snapshotId of retainedSnapshots) {
    const manifest = await loadSnapshotManifest(paths, snapshotId);
    await validateSnapshotStores(paths, manifest);
    retainedManifests.set(snapshotId, manifest);
  }

  const retainedGenerations = new Map<ClientStateSkeletonStoreKey, Set<string>>();
  for (const store of CLIENT_STATE_SKELETON_STORES) retainedGenerations.set(store.key, new Set(protectedMarkers.retainedGenerationIds));
  for (const manifest of retainedManifests.values()) {
    for (const store of CLIENT_STATE_SKELETON_STORES) {
      retainedGenerations.get(store.key)!.add(manifest.stores[store.key].generation);
    }
  }

  // 所有 retained manifest 已完整校验后才开始删除，任一损坏都会 fail closed。
  for (const store of CLIENT_STATE_SKELETON_STORES) {
    await cleanupInactiveStorageGenerations(store.root(paths), retainedGenerations.get(store.key)!, {
      retentionBucketsMs: STANDARD_STORAGE_GENERATION_RETENTION_BUCKETS_MS
    });
  }

  for (const [name, type] of await readDirectoryOrEmpty(snapshotsRootUri(paths))) {
    if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
    const snapshotId = name.slice(0, -'.json'.length);
    if (!retainedSnapshots.has(snapshotId)) {
      await deleteStorageUri(vscode.Uri.joinPath(snapshotsRootUri(paths), name), { useTrash: false });
    }
  }
  for (const uri of protectedMarkers.staleMarkerUris) {
    await deleteStorageUri(uri, { useTrash: false }).catch((error) => {
      if (!isFileNotFoundError(error)) throw error;
    });
  }
}

interface SkeletonTransactionMarkerScan {
  retainedSnapshotIds: Set<string>;
  retainedGenerationIds: Set<string>;
  staleMarkerUris: vscode.Uri[];
}

async function scanFreshTransactionMarkers(paths: StoragePaths, now: number): Promise<SkeletonTransactionMarkerScan> {
  const retainedSnapshotIds = new Set<string>();
  const retainedGenerationIds = new Set<string>();
  const staleMarkerUris: vscode.Uri[] = [];

  for (const [name, type] of await readDirectoryOrEmpty(preparingRootUri(paths))) {
    if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
    const uri = vscode.Uri.joinPath(preparingRootUri(paths), name);
    const result = await readJsonStrict<unknown>(uri);
    if (result.status !== 'ok') {
      staleMarkerUris.push(uri);
      continue;
    }
    const marker = parsePreparingMarker(result.value, uri);
    if (now - marker.startedAt > PREPARE_MARKER_STALE_MS) staleMarkerUris.push(uri);
    else retainedGenerationIds.add(marker.snapshotId);
  }

  for (const [name, type] of await readDirectoryOrEmpty(preparedRootUri(paths))) {
    if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
    const uri = vscode.Uri.joinPath(preparedRootUri(paths), name);
    const result = await readJsonStrict<unknown>(uri);
    if (result.status !== 'ok') {
      staleMarkerUris.push(uri);
      continue;
    }
    const marker = parsePreparedMarker(result.value, uri);
    const preparedAt = Date.parse(marker.preparedAt);
    if (!Number.isFinite(preparedAt) || now - preparedAt > PREPARE_MARKER_STALE_MS) staleMarkerUris.push(uri);
    else retainedSnapshotIds.add(marker.snapshotId);
  }

  return { retainedSnapshotIds, retainedGenerationIds, staleMarkerUris };
}

async function loadActiveSnapshotWithWholeFallback(paths: StoragePaths): Promise<LoadedSkeletonSnapshot | undefined> {
  let currentError: unknown;
  try {
    const current = await loadSnapshotFromPointerFile(paths, currentPointerUri(paths), false);
    if (current) {
      await validateSnapshotStores(paths, current.manifest);
      return current;
    }
  } catch (error) {
    currentError = error;
  }

  try {
    const previous = await loadSnapshotFromPointerFile(paths, previousPointerUri(paths), false);
    if (previous) {
      await validateSnapshotStores(paths, previous.manifest);
      console.warn(`[LimCode] Falling back to previous whole client-state skeleton snapshot ${previous.manifest.snapshotId}.`, currentError);
      return previous;
    }
  } catch (previousError) {
    if (currentError) {
      const error = new Error('Current and previous client-state skeleton snapshots are both invalid.');
      (error as Error & { causes?: unknown[] }).causes = [currentError, previousError];
      throw error;
    }
    throw previousError;
  }
  if (currentError) throw currentError;
  await assertNoSkeletonTracesWithoutPointer(paths);
  return undefined;
}

/**
 * current/previous 都缺失只能表示真正的空存储。只要 immutable snapshot、prepared、pin
 * 或任一领域 generation 仍存在，就不能把“指针丢失/提交中断”误判为空并初始化默认值。
 */
async function recoverAbandonedInitialCommit(paths: StoragePaths): Promise<boolean> {
  if (await tryLoadPointer(currentPointerUri(paths)) || await tryLoadPointer(previousPointerUri(paths))) return false;
  if ((await readDirectoryOrEmpty(snapshotsRootUri(paths))).length > 0) return false;
  if ((await readDirectoryOrEmpty(preparedRootUri(paths))).length > 0) return false;
  if ((await readDirectoryOrEmpty(pinsRootUri(paths))).length > 0) return false;

  const preparingEntries = await readDirectoryOrEmpty(preparingRootUri(paths));
  if (preparingEntries.length === 0) return false;
  const markerIds = new Set<string>();
  for (const [name, type] of preparingEntries) {
    if (type !== vscode.FileType.File || !name.endsWith('.json')) return false;
    const uri = vscode.Uri.joinPath(preparingRootUri(paths), name);
    const result = await readJsonStrict<unknown>(uri);
    if (result.status !== 'ok') return false;
    const marker = parsePreparingMarker(result.value, uri);
    if (marker.parentSnapshotId !== undefined) return false;
    markerIds.add(marker.snapshotId);
  }

  for (const store of CLIENT_STATE_SKELETON_STORES) {
    const generationsRoot = vscode.Uri.joinPath(store.root(paths), STORAGE_GENERATIONS_DIR);
    for (const [name, type] of await readDirectoryOrEmpty(generationsRoot)) {
      if (type !== vscode.FileType.Directory || !markerIds.has(name)) return false;
    }
  }

  for (const store of CLIENT_STATE_SKELETON_STORES) {
    for (const snapshotId of markerIds) {
      await deleteStorageUri(getStorageGenerationRootUri(store.root(paths), snapshotId), { recursive: true, useTrash: false })
        .catch((error) => { if (!isFileNotFoundError(error)) throw error; });
    }
  }
  for (const snapshotId of markerIds) {
    await deleteStorageUri(preparingUri(paths, snapshotId), { useTrash: false })
      .catch((error) => { if (!isFileNotFoundError(error)) throw error; });
  }
  console.warn(`[LimCode] Recovered abandoned initial client-state skeleton commit(s): ${[...markerIds].join(', ')}`);
  return true;
}

async function assertNoSkeletonTracesWithoutPointer(paths: StoragePaths): Promise<void> {
  const coordinatorTraces = [
    ...(await readDirectoryOrEmpty(snapshotsRootUri(paths))).map(([name]) => `${SNAPSHOTS_DIR}/${name}`),
    ...(await readDirectoryOrEmpty(preparingRootUri(paths))).map(([name]) => `${PREPARING_DIR}/${name}`),
    ...(await readDirectoryOrEmpty(preparedRootUri(paths))).map(([name]) => `${PREPARED_DIR}/${name}`),
    ...(await readDirectoryOrEmpty(pinsRootUri(paths))).map(([name]) => `${PINS_DIR}/${name}`)
  ];
  const generationTraces: string[] = [];
  for (const store of CLIENT_STATE_SKELETON_STORES) {
    const generationsRoot = vscode.Uri.joinPath(store.root(paths), STORAGE_GENERATIONS_DIR);
    for (const [name] of await readDirectoryOrEmpty(generationsRoot)) {
      generationTraces.push(`${store.key}/generations/${name}`);
      if (generationTraces.length >= 3) break;
    }
    if (generationTraces.length >= 3) break;
  }
  const traces = [...coordinatorTraces, ...generationTraces];
  if (traces.length > 0) {
    throw new Error(`Client-state skeleton pointer is missing while storage traces still exist: ${traces.slice(0, 6).join(', ')}`);
  }
}

async function loadSnapshotFromPointerFile(
  paths: StoragePaths,
  uri: vscode.Uri,
  allowMissing: boolean
): Promise<LoadedSkeletonSnapshot | undefined> {
  const pointer = await tryLoadPointer(uri);
  if (!pointer) {
    if (allowMissing) return undefined;
    return undefined;
  }
  const manifest = await loadSnapshotManifest(paths, pointer.snapshotId);
  const revision = createStorageRevision(manifest);
  if (revision !== pointer.manifestRevision) {
    throw new Error(`Client-state skeleton manifest revision mismatch: ${manifest.snapshotId}`);
  }
  return { pointer, manifest };
}

async function tryLoadPointer(uri: vscode.Uri): Promise<ClientStateSkeletonPointerFile | undefined> {
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') return undefined;
  if (result.status !== 'ok') throw new Error(`Client-state skeleton pointer is unreadable: ${uri.fsPath}`);
  return parsePointer(result.value, uri);
}

async function loadSnapshotManifest(paths: StoragePaths, snapshotId: string): Promise<ClientStateSkeletonSnapshotManifest> {
  if (!isSafeStorageGenerationId(snapshotId)) throw new Error(`Invalid client-state skeleton snapshot id: ${snapshotId}`);
  const uri = snapshotManifestUri(paths, snapshotId);
  const result = await readJsonStrict<unknown>(uri);
  if (result.status !== 'ok') throw new Error(`Client-state skeleton snapshot manifest is unavailable: ${uri.fsPath}`);
  return parseManifest(result.value, uri, snapshotId);
}

async function validateSnapshotStores(paths: StoragePaths, manifest: ClientStateSkeletonSnapshotManifest): Promise<void> {
  await Promise.all(CLIENT_STATE_SKELETON_STORES.map((store) => loadRecordStoreGeneration<ClientStateSkeletonRecord, string>(
    store.root(paths), manifest.stores[store.key], store.recordKey, store.key
  )));
}

function parsePointer(value: unknown, uri: vscode.Uri): ClientStateSkeletonPointerFile {
  const candidate = asPlainObject(value);
  if (!candidate || !hasExactKeys(candidate, ['kind', 'schemaVersion', 'snapshotId', 'manifestRevision', 'publishedAt'])
    || candidate.kind !== 'clientStateSkeleton.current' || candidate.schemaVersion !== STORAGE_VERSION
    || typeof candidate.snapshotId !== 'string' || !isSafeStorageGenerationId(candidate.snapshotId)
    || typeof candidate.manifestRevision !== 'string' || !candidate.manifestRevision
    || typeof candidate.publishedAt !== 'string' || !candidate.publishedAt) {
    throw new Error(`Client-state skeleton pointer structure is invalid: ${uri.fsPath}`);
  }
  return {
    kind: 'clientStateSkeleton.current',
    schemaVersion: STORAGE_VERSION,
    snapshotId: candidate.snapshotId,
    manifestRevision: candidate.manifestRevision,
    publishedAt: candidate.publishedAt
  };
}

function parseManifest(value: unknown, uri: vscode.Uri, expectedSnapshotId: string): ClientStateSkeletonSnapshotManifest {
  const candidate = asPlainObject(value);
  const allowed = candidate?.parentSnapshotId === undefined
    ? ['kind', 'schemaVersion', 'snapshotId', 'createdAt', 'stores']
    : ['kind', 'schemaVersion', 'snapshotId', 'parentSnapshotId', 'createdAt', 'stores'];
  if (!candidate || !hasExactKeys(candidate, allowed)
    || candidate.kind !== 'clientStateSkeleton.snapshot' || candidate.schemaVersion !== STORAGE_VERSION
    || candidate.snapshotId !== expectedSnapshotId || typeof candidate.createdAt !== 'string'
    || (candidate.parentSnapshotId !== undefined && (typeof candidate.parentSnapshotId !== 'string' || !isSafeStorageGenerationId(candidate.parentSnapshotId)))) {
    throw new Error(`Client-state skeleton snapshot manifest structure is invalid: ${uri.fsPath}`);
  }
  const rawStores = asPlainObject(candidate.stores);
  if (!rawStores || !hasExactKeys(rawStores, CLIENT_STATE_SKELETON_STORE_KEYS)) {
    throw new Error(`Client-state skeleton snapshot manifest store keys are invalid: ${uri.fsPath}`);
  }
  const stores = {} as Record<ClientStateSkeletonStoreKey, RecordStoreGenerationRef>;
  for (const key of CLIENT_STATE_SKELETON_STORE_KEYS) {
    const ref = asPlainObject(rawStores[key]);
    if (!ref || !hasExactKeys(ref, ['generation', 'revision'])
      || typeof ref.generation !== 'string' || !isSafeStorageGenerationId(ref.generation)
      || typeof ref.revision !== 'string' || !ref.revision) {
      throw new Error(`Client-state skeleton store ref is invalid (${key}): ${uri.fsPath}`);
    }
    stores[key] = { generation: ref.generation, revision: ref.revision };
  }
  return {
    kind: 'clientStateSkeleton.snapshot',
    schemaVersion: STORAGE_VERSION,
    snapshotId: expectedSnapshotId,
    ...(typeof candidate.parentSnapshotId === 'string' ? { parentSnapshotId: candidate.parentSnapshotId } : {}),
    createdAt: candidate.createdAt,
    stores
  };
}

function parsePreparingMarker(value: unknown, uri: vscode.Uri): ClientStateSkeletonPreparingMarker {
  const candidate = asPlainObject(value);
  const allowed = candidate?.parentSnapshotId === undefined
    ? ['kind', 'schemaVersion', 'snapshotId', 'ownerPid', 'startedAt']
    : ['kind', 'schemaVersion', 'snapshotId', 'parentSnapshotId', 'ownerPid', 'startedAt'];
  if (!candidate || !hasExactKeys(candidate, allowed)
    || candidate.kind !== 'clientStateSkeleton.preparing' || candidate.schemaVersion !== STORAGE_VERSION
    || typeof candidate.snapshotId !== 'string' || !isSafeStorageGenerationId(candidate.snapshotId)
    || (candidate.parentSnapshotId !== undefined && (typeof candidate.parentSnapshotId !== 'string' || !isSafeStorageGenerationId(candidate.parentSnapshotId)))
    || typeof candidate.ownerPid !== 'number' || !Number.isSafeInteger(candidate.ownerPid) || candidate.ownerPid <= 0
    || typeof candidate.startedAt !== 'number' || !Number.isFinite(candidate.startedAt)) {
    throw new Error(`Client-state skeleton preparing marker structure is invalid: ${uri.fsPath}`);
  }
  return {
    kind: 'clientStateSkeleton.preparing',
    schemaVersion: STORAGE_VERSION,
    snapshotId: candidate.snapshotId,
    ...(typeof candidate.parentSnapshotId === 'string' ? { parentSnapshotId: candidate.parentSnapshotId } : {}),
    ownerPid: candidate.ownerPid,
    startedAt: candidate.startedAt
  };
}

function parsePreparedMarker(value: unknown, uri: vscode.Uri): ClientStateSkeletonPreparedMarker {
  const candidate = asPlainObject(value);
  const allowed = candidate?.parentSnapshotId === undefined
    ? ['kind', 'schemaVersion', 'snapshotId', 'manifestRevision', 'preparedAt']
    : ['kind', 'schemaVersion', 'snapshotId', 'parentSnapshotId', 'manifestRevision', 'preparedAt'];
  if (!candidate || !hasExactKeys(candidate, allowed)
    || candidate.kind !== 'clientStateSkeleton.prepared' || candidate.schemaVersion !== STORAGE_VERSION
    || typeof candidate.snapshotId !== 'string' || !isSafeStorageGenerationId(candidate.snapshotId)
    || (candidate.parentSnapshotId !== undefined && (typeof candidate.parentSnapshotId !== 'string' || !isSafeStorageGenerationId(candidate.parentSnapshotId)))
    || typeof candidate.manifestRevision !== 'string' || !candidate.manifestRevision
    || typeof candidate.preparedAt !== 'string' || !candidate.preparedAt) {
    throw new Error(`Client-state skeleton prepared marker structure is invalid: ${uri.fsPath}`);
  }
  return {
    kind: 'clientStateSkeleton.prepared',
    schemaVersion: STORAGE_VERSION,
    snapshotId: candidate.snapshotId,
    ...(typeof candidate.parentSnapshotId === 'string' ? { parentSnapshotId: candidate.parentSnapshotId } : {}),
    manifestRevision: candidate.manifestRevision,
    preparedAt: candidate.preparedAt
  };
}

function parsePin(value: unknown, uri: vscode.Uri): ClientStateSkeletonPinFile {
  const candidate = asPlainObject(value);
  if (!candidate || !hasExactKeys(candidate, ['kind', 'schemaVersion', 'pinId', 'snapshotId', 'ownerId', 'pid', 'createdAt', 'heartbeatAt'])
    || candidate.kind !== 'clientStateSkeleton.pin' || candidate.schemaVersion !== STORAGE_VERSION
    || typeof candidate.pinId !== 'string' || !candidate.pinId
    || typeof candidate.snapshotId !== 'string' || !isSafeStorageGenerationId(candidate.snapshotId)
    || typeof candidate.ownerId !== 'string' || !candidate.ownerId
    || typeof candidate.pid !== 'number' || !Number.isSafeInteger(candidate.pid) || candidate.pid <= 0
    || typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt)
    || typeof candidate.heartbeatAt !== 'number' || !Number.isFinite(candidate.heartbeatAt)) {
    throw new Error(`Client-state skeleton pin structure is invalid: ${uri.fsPath}`);
  }
  return {
    kind: 'clientStateSkeleton.pin', schemaVersion: STORAGE_VERSION,
    pinId: candidate.pinId, snapshotId: candidate.snapshotId, ownerId: candidate.ownerId,
    pid: candidate.pid, createdAt: candidate.createdAt, heartbeatAt: candidate.heartbeatAt
  };
}

function descriptorFor(key: ClientStateSkeletonStoreKey) {
  const descriptor = CLIENT_STATE_SKELETON_STORES.find((store) => store.key === key);
  if (!descriptor) throw new Error(`Unknown client-state skeleton store: ${key}`);
  return descriptor;
}

function assertExactStoreRefs(stores: Partial<Record<ClientStateSkeletonStoreKey, RecordStoreGenerationRef>>): asserts stores is Record<ClientStateSkeletonStoreKey, RecordStoreGenerationRef> {
  const keys = Object.keys(stores).sort();
  const expected = [...CLIENT_STATE_SKELETON_STORE_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`Client-state skeleton store refs are incomplete: ${keys.join(', ')}`);
  }
}

function cloneStoreRefs(stores: Record<ClientStateSkeletonStoreKey, RecordStoreGenerationRef>): Record<ClientStateSkeletonStoreKey, RecordStoreGenerationRef> {
  return Object.fromEntries(Object.entries(stores).map(([key, ref]) => [key, { ...ref }])) as Record<ClientStateSkeletonStoreKey, RecordStoreGenerationRef>;
}

function cloneManifest(manifest: ClientStateSkeletonSnapshotManifest): ClientStateSkeletonSnapshotManifest {
  return { ...manifest, stores: cloneStoreRefs(manifest.stores) };
}

async function withSkeletonCoordinatorLock<T>(paths: StoragePaths, action: () => Promise<T>): Promise<T> {
  await ensureStorageDirectory(paths.clientStateSkeletonRootUri);
  return withStorageResourceLock(transactionResourceUri(paths), action, {
    staleMs: SKELETON_LOCK_STALE_MS,
    waitMs: SKELETON_LOCK_WAIT_MS,
    heartbeatIntervalMs: 1_000
  });
}

async function readDirectoryOrEmpty(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await readStorageDirectory(uri);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

function currentPointerUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.clientStateSkeletonRootUri, CURRENT_POINTER_FILE);
}
function previousPointerUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.clientStateSkeletonRootUri, PREVIOUS_POINTER_FILE);
}
function snapshotsRootUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.clientStateSkeletonRootUri, SNAPSHOTS_DIR);
}
function snapshotManifestUri(paths: StoragePaths, snapshotId: string): vscode.Uri {
  return vscode.Uri.joinPath(snapshotsRootUri(paths), `${snapshotId}.json`);
}
function preparingRootUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.clientStateSkeletonRootUri, PREPARING_DIR);
}
function preparingUri(paths: StoragePaths, snapshotId: string): vscode.Uri {
  return vscode.Uri.joinPath(preparingRootUri(paths), `${snapshotId}.json`);
}
function preparedRootUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.clientStateSkeletonRootUri, PREPARED_DIR);
}
function preparedUri(paths: StoragePaths, snapshotId: string): vscode.Uri {
  return vscode.Uri.joinPath(preparedRootUri(paths), `${snapshotId}.json`);
}
function pinsRootUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.clientStateSkeletonRootUri, PINS_DIR);
}
function pinUri(paths: StoragePaths, pinId: string): vscode.Uri {
  if (!/^[a-f0-9-]{36}$/i.test(pinId)) throw new Error(`Invalid client-state skeleton pin id: ${pinId}`);
  return vscode.Uri.joinPath(pinsRootUri(paths), `${pinId}.json`);
}
function transactionResourceUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.clientStateSkeletonRootUri, TRANSACTION_RESOURCE);
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
