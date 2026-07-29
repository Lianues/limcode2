import type { ClientState } from '../../../shared/protocol';
import {
  CLIENT_STATE_SKELETON_STORES,
  skeletonRecordsFromState,
  type ClientStateSkeletonRecord,
  type ClientStateSkeletonStoreKey
} from './clientStateSkeletonStores';
import { createStorageRevision } from './storageRevision';

export interface ClientStateSkeletonRecordUpsert {
  record: ClientStateSkeletonRecord;
  /** null 表示本地已确认 base 中不存在该 id。 */
  expectedRecordRevision: string | null;
}

export interface ClientStateSkeletonRecordRemove {
  id: string;
  expectedRecordRevision: string;
}

export interface ClientStateSkeletonStorePatch {
  upserts: ClientStateSkeletonRecordUpsert[];
  removes: ClientStateSkeletonRecordRemove[];
}

export type ClientStateSkeletonPatch = Partial<Record<ClientStateSkeletonStoreKey, ClientStateSkeletonStorePatch>>;

export interface AppliedClientStateSkeletonStorePatch {
  records: ClientStateSkeletonRecord[];
  changed: boolean;
}

export class ClientStateSkeletonRevisionConflictError extends Error {
  public readonly clientStateSkeletonRevisionConflict = true;

  public constructor(
    public readonly storeKey: ClientStateSkeletonStoreKey,
    public readonly recordId: string,
    public readonly operation: 'upsert' | 'remove',
    public readonly expectedRevision: string | null,
    public readonly actualRevision: string | null
  ) {
    super(`Client-state skeleton conflict in ${storeKey}/${recordId} (${operation}): expected=${expectedRevision ?? 'missing'}, actual=${actualRevision ?? 'missing'}`);
    this.name = 'ClientStateSkeletonRevisionConflictError';
  }
}

export function isClientStateSkeletonRevisionConflictError(error: unknown): error is ClientStateSkeletonRevisionConflictError {
  if (error instanceof ClientStateSkeletonRevisionConflictError) return true;
  return !!error && typeof error === 'object'
    && (error as { clientStateSkeletonRevisionConflict?: unknown }).clientStateSkeletonRevisionConflict === true;
}

/**
 * 只根据“本进程上次确认的本地 base -> 当前本地 next”生成 patch。未出现在 patch 中的
 * 外部 record 永远不会被误判为删除，因此陈旧窗口追加不同 id 时自然形成 union。
 */
export function createClientStateSkeletonPatch(base: ClientState, next: ClientState): ClientStateSkeletonPatch {
  const patch: ClientStateSkeletonPatch = {};
  for (const store of CLIENT_STATE_SKELETON_STORES) {
    const baseRecords = skeletonRecordsFromState(base, store.key);
    const nextRecords = skeletonRecordsFromState(next, store.key);
    const baseById = uniqueRecordMap(baseRecords, `${store.key}:base`);
    const nextById = uniqueRecordMap(nextRecords, `${store.key}:next`);
    const upserts: ClientStateSkeletonRecordUpsert[] = [];
    const removes: ClientStateSkeletonRecordRemove[] = [];

    for (const record of nextRecords) {
      const previous = baseById.get(record.id);
      if (!previous) {
        upserts.push({ record: cloneRecord(record), expectedRecordRevision: null });
        continue;
      }
      const previousRevision = createStorageRevision(previous);
      if (createStorageRevision(record) !== previousRevision) {
        upserts.push({ record: cloneRecord(record), expectedRecordRevision: previousRevision });
      }
    }
    for (const record of baseRecords) {
      if (!nextById.has(record.id)) {
        removes.push({ id: record.id, expectedRecordRevision: createStorageRevision(record) });
      }
    }
    if (upserts.length > 0 || removes.length > 0) patch[store.key] = { upserts, removes };
  }
  return patch;
}

/** 在最新 committed store 上做 per-record CAS；所有冲突均在 generation 写入前抛出。 */
export function applyClientStateSkeletonStorePatch(
  storeKey: ClientStateSkeletonStoreKey,
  currentRecords: ClientStateSkeletonRecord[],
  patch: ClientStateSkeletonStorePatch
): AppliedClientStateSkeletonStorePatch {
  const currentById = uniqueRecordMap(currentRecords, `${storeKey}:current`);
  const nextById = new Map(currentById);
  let changed = false;

  for (const upsert of patch.upserts) {
    const current = nextById.get(upsert.record.id);
    const actualRevision = current ? createStorageRevision(current) : null;
    const desiredRevision = createStorageRevision(upsert.record);
    if (actualRevision === desiredRevision) continue; // commit 已成功但响应不确定时的幂等重试
    if (actualRevision !== upsert.expectedRecordRevision) {
      throw new ClientStateSkeletonRevisionConflictError(
        storeKey,
        upsert.record.id,
        'upsert',
        upsert.expectedRecordRevision,
        actualRevision
      );
    }
    nextById.set(upsert.record.id, cloneRecord(upsert.record));
    changed = true;
  }

  for (const remove of patch.removes) {
    const current = nextById.get(remove.id);
    if (!current) continue; // 删除已提交或其他 writer 做了同一删除
    const actualRevision = createStorageRevision(current);
    if (actualRevision !== remove.expectedRecordRevision) {
      throw new ClientStateSkeletonRevisionConflictError(
        storeKey,
        remove.id,
        'remove',
        remove.expectedRecordRevision,
        actualRevision
      );
    }
    nextById.delete(remove.id);
    changed = true;
  }

  // 保留 current 顺序；新增项按本地 patch 顺序追加。已有项更新不改变位置。
  const records: ClientStateSkeletonRecord[] = [];
  const emitted = new Set<string>();
  for (const current of currentRecords) {
    const next = nextById.get(current.id);
    if (!next) continue;
    records.push(next);
    emitted.add(current.id);
  }
  for (const upsert of patch.upserts) {
    if (emitted.has(upsert.record.id)) continue;
    const next = nextById.get(upsert.record.id);
    if (!next) continue;
    records.push(next);
    emitted.add(next.id);
  }
  return { records, changed };
}

export function isEmptyClientStateSkeletonPatch(patch: ClientStateSkeletonPatch): boolean {
  return Object.keys(patch).length === 0;
}

function uniqueRecordMap(records: ClientStateSkeletonRecord[], label: string): Map<string, ClientStateSkeletonRecord> {
  const result = new Map<string, ClientStateSkeletonRecord>();
  for (const record of records) {
    if (!record.id.trim() || result.has(record.id)) throw new Error(`Duplicate or empty skeleton record id in ${label}: ${record.id}`);
    result.set(record.id, record);
  }
  return result;
}

function cloneRecord(record: ClientStateSkeletonRecord): ClientStateSkeletonRecord {
  return JSON.parse(JSON.stringify(record)) as ClientStateSkeletonRecord;
}
