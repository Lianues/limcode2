import { CLIENT_STATE_TABLES, type ClientStateTablePatchSpec } from '../../../shared/clientStateRegistry';
import type { ClientPatchOp, ClientState, ClientStateTableKey } from '../../../shared/protocol';

export function diffUpsertRemove<T extends { id: string }, TUpsert extends ClientPatchOp, TRemove extends ClientPatchOp>(
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
    const upsert = patch.upsert;
    const remove = patch.remove;
    if (!upsert || !remove) continue;

    patches.push(...diffUpsertRemove(
      prev[tableKey] as Array<{ id: string }>,
      next[tableKey] as Array<{ id: string }>,
      (record): ClientPatchOp => ({ kind: upsert.kind, [upsert.payloadField]: record } as unknown as ClientPatchOp),
      (id): ClientPatchOp => ({ kind: remove.kind, id } as ClientPatchOp)
    ));
  }
  return patches;
}
