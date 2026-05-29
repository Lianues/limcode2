import type { ClientPatchOp } from '../../../shared/protocol';

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
