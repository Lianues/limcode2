import { CLIENT_STATE_TABLES, type ClientStateTablePatchSpec } from '../../../shared/clientStateSchema';
import type { ClientPatchOp, ClientState, ClientStateTableKey } from '../../../shared/protocol';

type RecordWithId = { id: string };

export function diffUpsertRemove<T extends RecordWithId, TUpsert extends ClientPatchOp, TRemove extends ClientPatchOp>(
  prev: T[],
  next: T[],
  createUpsert: (item: T) => TUpsert,
  createRemove: (id: string) => TRemove
): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  const prevMap = new Map(prev.map((item) => [item.id, item]));
  const nextMap = new Map(next.map((item) => [item.id, item]));

  for (const item of next) {
    const old = prevMap.get(item.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(item)) {
      patches.push(createUpsert(item));
    }
  }

  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) {
      patches.push(createRemove(id));
    }
  }

  return patches;
}

export function diffClientStateTables(prev: ClientState, next: ClientState, tableKeys: readonly ClientStateTableKey[]): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  for (const tableKey of tableKeys) {
    const spec = CLIENT_STATE_TABLES[tableKey];
    if (spec.clientSync.diff !== 'generic') continue;

    const patch = spec.patch as ClientStateTablePatchSpec;
    const prevRecords = prev[tableKey] as RecordWithId[];
    const nextRecords = next[tableKey] as RecordWithId[];
    const remove = patch.remove;
    if (!remove) continue;

    if (patch.upsert) {
      patches.push(...diffUpsertRemove(
        prevRecords,
        nextRecords,
        (record): ClientPatchOp => ({ kind: patch.upsert!.kind, [patch.upsert!.payloadField]: record } as unknown as ClientPatchOp),
        (id): ClientPatchOp => ({ kind: remove.kind, id } as ClientPatchOp)
      ));
      continue;
    }

    if (patch.append) {
      patches.push(...diffAppendRemove(
        prevRecords,
        nextRecords,
        (record): ClientPatchOp => ({ kind: patch.append!.kind, [patch.append!.payloadField]: record } as unknown as ClientPatchOp),
        (id): ClientPatchOp => ({ kind: remove.kind, id } as ClientPatchOp)
      ));
    }
  }
  return patches;
}

function diffAppendRemove<T extends RecordWithId, TAppend extends ClientPatchOp, TRemove extends ClientPatchOp>(
  prev: T[],
  next: T[],
  createAppend: (item: T) => TAppend,
  createRemove: (id: string) => TRemove
): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  const prevIds = new Set(prev.map((item) => item.id));
  const nextIds = new Set(next.map((item) => item.id));

  for (const item of next) {
    if (!prevIds.has(item.id)) patches.push(createAppend(item));
  }

  for (const id of prevIds) {
    if (!nextIds.has(id)) patches.push(createRemove(id));
  }

  return patches;
}
