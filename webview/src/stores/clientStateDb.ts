import {
  CLIENT_STATE_TABLES,
  CLIENT_STATE_TABLE_KEYS,
  GENERIC_CLIENT_MUTATION_APPLY_BY_KIND,
  GENERIC_CLIENT_PATCH_APPLY_BY_KIND,
  GLOBAL_CLIENT_STATE_TABLE_KEYS,
  type ClientStateMutationApplySpec,
  type ClientStateMutationPathSegment,
  type ClientStateScopeSpec,
  type ClientStateSortSpec
} from '@shared/clientStateSchema';
import {
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationIdFromClientStateStreamId,
  type ClientPatchOp,
  type ClientState,
  type ClientStateTableKey
} from '@shared/protocol';
import { compactClientPatchOps } from './clientPatchCompaction';

export interface ClientStateDb {
  applySnapshot(streamId: string, state: ClientState): boolean;
  applyPatch(patch: ClientPatchOp): void;
  applyPatches(patches: readonly ClientPatchOp[]): void;
}

type ClientStateMutableRecord = { id: string; [key: string]: unknown };
type ClientStatePathKey = string | number;
type ConversationScopeIndex = Map<ClientStateTableKey, Set<string>>;

export function createClientStateDb(clientState: ClientState): ClientStateDb {
  return new ClientStateDbImpl(clientState);
}

class ClientStateDbImpl implements ClientStateDb {
  private readonly indexCache = new Map<ClientStateTableKey, { list: ClientStateMutableRecord[]; indexById: Map<string, number> }>();
  private sortDeferDepth = 0;
  private readonly pendingSortTables = new Set<ClientStateTableKey>();

  public constructor(private readonly clientState: ClientState) {}

  public applySnapshot(streamId: string, state: ClientState): boolean {
    if (streamId === GLOBAL_CLIENT_STATE_STREAM_ID) {
      this.applyGlobalSnapshot(state);
      return true;
    }

    const conversationId = conversationIdFromClientStateStreamId(streamId) ?? state.conversations[0]?.id ?? state.messages[0]?.conversationId;
    if (!conversationId) return false;
    this.replaceConversationState(conversationId, state);
    return true;
  }

  private applyGlobalSnapshot(state: ClientState): void {
    copyClientStateTables(this.clientState, state, GLOBAL_CLIENT_STATE_TABLE_KEYS);
    this.clearIndexCache();
  }

  private replaceConversationState(conversationId: string, state: ClientState): void {
    const scopedIds = this.buildConversationScopeIndex(this.clientState, conversationId);

    for (const tableKey of CLIENT_STATE_TABLE_KEYS) {
      const scope = CLIENT_STATE_TABLES[tableKey].clientSync.scope;
      if (!scope) continue;

      const mode = scopeReplaceMode(scope);
      const target = this.records(tableKey);
      const incoming = this.recordsFrom(state, tableKey);

      if (mode === 'replace') {
        const ids = scopedIds.get(tableKey) ?? new Set<string>();
        if (removeWhere(target, (record) => ids.has(record.id))) this.invalidateIndex(tableKey);
      }

      if (mode !== 'removeOnly') {
        for (const record of incoming) this.upsertRecord(tableKey, record);
        this.markSortTable(tableKey);
      }
    }
  }

  public applyPatches(patches: readonly ClientPatchOp[]): void {
    const compacted = compactClientPatchOps(patches);
    if (compacted.length === 0) return;

    this.sortDeferDepth += 1;
    try {
      for (const patch of compacted) this.applyPatch(patch);
    } finally {
      this.sortDeferDepth -= 1;
      if (this.sortDeferDepth === 0) this.flushPendingSorts();
    }
  }

  public applyPatch(patch: ClientPatchOp): void {
    if (this.applyGenericClientPatchOp(patch)) return;
    if (this.applyGenericClientMutationPatchOp(patch)) return;
  }

  private applyGenericClientPatchOp(patch: ClientPatchOp): boolean {
    const operation = GENERIC_CLIENT_PATCH_APPLY_BY_KIND[patch.kind];
    if (!operation) return false;

    if (operation.operation === 'remove') {
      this.removeRegisteredRecord(operation.tableKey, (patch as { id: string }).id);
      return true;
    }

    const payloadField = operation.payloadField;
    if (!payloadField) return false;
    const record = (patch as unknown as Record<string, unknown>)[payloadField] as ClientStateMutableRecord | undefined;
    if (!record) return false;
    this.upsertRecord(operation.tableKey, record);
    this.markSortTable(operation.tableKey);
    return true;
  }

  private applyGenericClientMutationPatchOp(patch: ClientPatchOp): boolean {
    const operation = GENERIC_CLIENT_MUTATION_APPLY_BY_KIND[patch.kind];
    if (!operation) return false;

    const record = this.recordById(operation.tableKey, (patch as { id: string }).id);
    if (!record) return true;

    applyMutation(record, patch as unknown as Record<string, unknown>, operation.apply);
    return true;
  }

  private removeRegisteredRecord(tableKey: ClientStateTableKey, id: string, visited = new Set<string>()): void {
    const visitKey = `${tableKey}:${id}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    const spec = CLIENT_STATE_TABLES[tableKey].clientSync;
    if ('removeScope' in spec && spec.removeScope?.kind === 'conversation') {
      this.removeConversationScopedState(id);
    }

    for (const cascade of spec.cascadeRemove ?? []) {
      const childRecords = this.records(cascade.table);
      const childIds = childRecords
        .filter((record) => cascadeForeignKeys(cascade).some((foreignKey) => record[foreignKey] === id))
        .map((record) => record.id);

      if ('cascade' in cascade && cascade.cascade) {
        for (const childId of childIds) this.removeRegisteredRecord(cascade.table, childId, visited);
      } else if (removeWhere(childRecords, (record) => cascadeForeignKeys(cascade).some((foreignKey) => record[foreignKey] === id))) {
        this.invalidateIndex(cascade.table);
      }
    }

    this.removeRecordById(tableKey, id);
  }

  private removeConversationScopedState(conversationId: string): void {
    const scopedIds = this.buildConversationScopeIndex(this.clientState, conversationId);
    for (const tableKey of CLIENT_STATE_TABLE_KEYS) {
      const scope = CLIENT_STATE_TABLES[tableKey].clientSync.scope;
      if (!scope || scopeReplaceMode(scope) === 'upsertOnly') continue;
      const ids = scopedIds.get(tableKey);
      if (!ids || ids.size === 0) continue;
      if (removeWhere(this.records(tableKey), (record) => ids.has(record.id))) this.invalidateIndex(tableKey);
    }
  }

  private buildConversationScopeIndex(source: ClientState, conversationId: string): ConversationScopeIndex {
    const scopedIds: ConversationScopeIndex = new Map();
    let changed = true;
    while (changed) {
      changed = false;
      for (const tableKey of CLIENT_STATE_TABLE_KEYS) {
        const scope = CLIENT_STATE_TABLES[tableKey].clientSync.scope;
        if (!scope) continue;
        for (const record of this.recordsFrom(source, tableKey)) {
          if (isConversationScoped(scopedIds, tableKey, record.id)) continue;
          if (!this.matchesConversationScope(source, scopedIds, record, scope, conversationId)) continue;
          markConversationScoped(scopedIds, tableKey, record.id);
          changed = true;
        }
      }
    }
    return scopedIds;
  }

  private matchesConversationScope(
    source: ClientState,
    scopedIds: ConversationScopeIndex,
    record: ClientStateMutableRecord,
    scope: ClientStateScopeSpec,
    conversationId: string
  ): boolean {
    switch (scope.kind) {
      case 'global':
        return false;
      case 'conversation':
        return record[scope.field] === conversationId;
      case 'conversationAny':
        return scope.fields.some((field: string) => record[field] === conversationId);
      case 'conversationVia':
        return this.recordsFrom(source, scope.table).some((target) => target[scope.foreignField] === record[scope.localField] && isConversationScoped(scopedIds, scope.table, target.id));
      case 'conversationReverseVia':
        return this.recordsFrom(source, scope.table).some((target) => target[scope.foreignField] === record[scope.localField] && isConversationScoped(scopedIds, scope.table, target.id));
      case 'conversationAnyOf':
        return scope.scopes.some((candidate: ClientStateScopeSpec) => this.matchesConversationScope(source, scopedIds, record, candidate, conversationId));
    }
    return false;
  }

  private markSortTable(tableKey: ClientStateTableKey): void {
    const orderBy = CLIENT_STATE_TABLES[tableKey].clientSync.orderBy;
    if (!orderBy || orderBy.length === 0) return;
    if (this.sortDeferDepth > 0) {
      this.pendingSortTables.add(tableKey);
      return;
    }
    this.sortRegisteredTable(tableKey);
  }

  private flushPendingSorts(): void {
    if (this.pendingSortTables.size === 0) return;
    const tables = [...this.pendingSortTables];
    this.pendingSortTables.clear();
    for (const tableKey of tables) this.sortRegisteredTable(tableKey);
  }

  private sortRegisteredTable(tableKey: ClientStateTableKey): void {
    const orderBy = CLIENT_STATE_TABLES[tableKey].clientSync.orderBy;
    if (!orderBy || orderBy.length === 0) return;
    this.records(tableKey).sort((left, right) => compareRecords(left, right, orderBy));
    this.invalidateIndex(tableKey);
  }

  private upsertRecord(tableKey: ClientStateTableKey, record: ClientStateMutableRecord): void {
    const list = this.records(tableKey);
    const indexById = this.indexById(tableKey);
    const next = cloneRecord(record);
    const index = indexById.get(record.id);
    if (index !== undefined) {
      list[index] = next;
      return;
    }
    indexById.set(record.id, list.length);
    list.push(next);
  }

  private recordById(tableKey: ClientStateTableKey, id: string): ClientStateMutableRecord | undefined {
    const index = this.indexById(tableKey).get(id);
    return index === undefined ? undefined : this.records(tableKey)[index];
  }

  private removeRecordById(tableKey: ClientStateTableKey, id: string): void {
    const index = this.indexById(tableKey).get(id);
    if (index === undefined) return;
    this.records(tableKey).splice(index, 1);
    this.invalidateIndex(tableKey);
  }

  private indexById(tableKey: ClientStateTableKey): Map<string, number> {
    const list = this.records(tableKey);
    const cached = this.indexCache.get(tableKey);
    if (cached?.list === list) return cached.indexById;
    const indexById = new Map<string, number>();
    list.forEach((record, index) => indexById.set(record.id, index));
    this.indexCache.set(tableKey, { list, indexById });
    return indexById;
  }

  private invalidateIndex(tableKey: ClientStateTableKey): void {
    this.indexCache.delete(tableKey);
  }

  private clearIndexCache(): void {
    this.indexCache.clear();
  }

  private records(tableKey: ClientStateTableKey): ClientStateMutableRecord[] {
    return this.recordsFrom(this.clientState, tableKey);
  }

  private recordsFrom(source: ClientState, tableKey: ClientStateTableKey): ClientStateMutableRecord[] {
    return source[tableKey] as ClientStateMutableRecord[];
  }
}

function applyMutation(record: ClientStateMutableRecord, patch: Record<string, unknown>, apply: ClientStateMutationApplySpec): void {
  if (apply.op === 'setPath') {
    const path = resolveMutationPath(apply.path, patch);
    if (!path) return;
    setPathValue(record, path, patch[apply.valueField]);
    return;
  }

  if (apply.op === 'appendStringAtPath') {
    const path = resolveMutationPath(apply.path, patch);
    if (!path) return;
    const current = getPathValue(record, path);
    const delta = patch[apply.valueField];
    if (typeof current !== 'string' || typeof delta !== 'string') return;
    setPathValue(record, path, current + delta);
    return;
  }

  if (apply.op === 'insertArrayItem') {
    const path = resolveMutationPath(apply.path, patch);
    if (!path) return;
    const list = getPathValue(record, path);
    const index = patch[apply.indexField];
    if (!Array.isArray(list) || typeof index !== 'number') return;
    list.splice(index, 0, cloneValue(patch[apply.itemField]));
  }
}

function copyClientStateTables<TTarget extends ClientState>(
  target: TTarget,
  source: ClientState,
  keys: readonly ClientStateTableKey[]
): TTarget {
  const writableTarget = target as unknown as Record<ClientStateTableKey, unknown>;
  const readableSource = source as unknown as Record<ClientStateTableKey, ClientStateMutableRecord[]>;
  for (const key of keys) {
    writableTarget[key] = readableSource[key].map(cloneRecord);
  }
  return target;
}

function resolveMutationPath(path: readonly ClientStateMutationPathSegment[], patch: Record<string, unknown>): ClientStatePathKey[] | undefined {
  const resolved: ClientStatePathKey[] = [];
  for (const segment of path) {
    if (typeof segment === 'string') {
      resolved.push(segment);
      continue;
    }
    const value = patch[segment.fromField];
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    resolved.push(value);
  }
  return resolved;
}

function getPathValue(root: unknown, path: readonly ClientStatePathKey[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<ClientStatePathKey, unknown>)[segment];
  }
  return current;
}

function setPathValue(root: unknown, path: readonly ClientStatePathKey[], value: unknown): void {
  if (path.length === 0) return;
  const parent = getPathValue(root, path.slice(0, -1));
  if (parent === null || parent === undefined) return;
  (parent as Record<ClientStatePathKey, unknown>)[path[path.length - 1]] = value;
}

function cascadeForeignKeys(cascade: { readonly foreignKey?: string; readonly foreignKeys?: readonly string[] }): readonly string[] {
  return cascade.foreignKeys ?? (cascade.foreignKey ? [cascade.foreignKey] : []);
}

function compareRecords(left: ClientStateMutableRecord, right: ClientStateMutableRecord, orderBy: readonly ClientStateSortSpec[]): number {
  for (const sort of orderBy) {
    const result = compareValues(left[sort.field], right[sort.field]);
    if (result !== 0) return sort.direction === 'desc' ? -result : result;
  }
  return 0;
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function removeWhere<T>(list: T[], predicate: (item: T) => boolean): boolean {
  let removed = false;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (!predicate(list[index])) continue;
    list.splice(index, 1);
    removed = true;
  }
  return removed;
}

function cloneRecord<T extends { id: string }>(record: T): T {
  return cloneValue(record);
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isConversationScoped(scopedIds: ConversationScopeIndex, tableKey: ClientStateTableKey, id: string): boolean {
  return scopedIds.get(tableKey)?.has(id) ?? false;
}

function markConversationScoped(scopedIds: ConversationScopeIndex, tableKey: ClientStateTableKey, id: string): void {
  const ids = scopedIds.get(tableKey);
  if (ids) ids.add(id);
  else scopedIds.set(tableKey, new Set([id]));
}

function scopeReplaceMode(scope: ClientStateScopeSpec): 'replace' | 'upsertOnly' | 'removeOnly' {
  return 'replace' in scope && scope.replace ? scope.replace : 'replace';
}
