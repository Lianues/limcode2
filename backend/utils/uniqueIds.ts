import type { ComponentType, Entity, WorldReader } from '../ecs/types';
import type { ClientState, ClientStateTableKey } from '../../shared/protocol';

export class DuplicateStableIdError extends Error {
  public readonly code = 'duplicate_id';
  public readonly kind: string;
  public readonly id: string;
  public readonly entities?: readonly Entity[];

  public constructor(kind: string, id: string, entities?: readonly Entity[]) {
    super(entities && entities.length > 0
      ? `Duplicate ${kind} id: ${id} (${entities.join(', ')})`
      : `Duplicate ${kind} id: ${id}`);
    this.name = 'DuplicateStableIdError';
    this.kind = kind;
    this.id = id;
    this.entities = entities;
  }
}

export interface IdRecord {
  readonly id: string;
}

export function buildUniqueComponentIndex<T extends IdRecord>(
  world: WorldReader,
  component: ComponentType<T>,
  kind = component.name
): Map<string, Entity> {
  const byId = new Map<string, Entity>();
  for (const entity of world.query(component)) {
    const record = world.get(entity, component);
    if (!record?.id) continue;
    const existing = byId.get(record.id);
    if (existing !== undefined && existing !== entity) {
      throw new DuplicateStableIdError(kind, record.id, [existing, entity]);
    }
    byId.set(record.id, entity);
  }
  return byId;
}

export function findUniqueById<T extends IdRecord>(
  world: WorldReader,
  component: ComponentType<T>,
  id: string,
  kind = component.name
): Entity | undefined {
  let found: Entity | undefined;
  const duplicates: Entity[] = [];
  for (const entity of world.query(component)) {
    const record = world.get(entity, component);
    if (record?.id !== id) continue;
    if (found === undefined) found = entity;
    else duplicates.push(entity);
  }
  if (found !== undefined && duplicates.length > 0) {
    throw new DuplicateStableIdError(kind, id, [found, ...duplicates]);
  }
  return found;
}

export function assertUniqueRecords<T extends IdRecord>(records: readonly T[] | undefined, kind: string): void {
  if (!records || records.length === 0) return;
  const seen = new Map<string, number>();
  for (let index = 0; index < records.length; index += 1) {
    const id = records[index]?.id;
    if (!id) continue;
    const previousIndex = seen.get(id);
    if (previousIndex !== undefined) {
      throw new DuplicateStableIdError(kind, id, [previousIndex, index]);
    }
    seen.set(id, index);
  }
}

export function assertUniqueClientStateIds(state: Partial<ClientState>, label = 'ClientState'): void {
  for (const [key, value] of Object.entries(state) as Array<[ClientStateTableKey, unknown]>) {
    if (!Array.isArray(value)) continue;
    assertUniqueRecords(value as readonly IdRecord[], `${label}.${key}`);
  }
}

export function duplicateStableIdCode(error: unknown): 'duplicate_id' | undefined {
  return error instanceof DuplicateStableIdError ? error.code : undefined;
}
