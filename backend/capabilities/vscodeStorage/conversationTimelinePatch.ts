import type { ClientState, ClientStateTableKey } from '../../../shared/protocol';
import { createStorageRevision } from './storageRevision';

export const CONVERSATION_TIMELINE_TABLE_KEYS = [
  'messages',
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'toolCalls',
  'toolCallEvents',
  'projectContexts',
  'shadowRepositories',
  'conversationCheckpointRepositoryLinks',
  'checkpoints',
  'checkpointTimelineAnchors'
] as const satisfies readonly ClientStateTableKey[];

export type ConversationTimelineTableKey = typeof CONVERSATION_TIMELINE_TABLE_KEYS[number];
export type ConversationTimelineRecord = { id: string };

export interface ConversationTimelineRecordUpsert {
  record: ConversationTimelineRecord;
  expectedRecordRevision: string | null;
}

export interface ConversationTimelineRecordRemove {
  id: string;
  expectedRecordRevision: string;
}

export interface ConversationTimelineTablePatch {
  upserts: ConversationTimelineRecordUpsert[];
  removes: ConversationTimelineRecordRemove[];
}

export type ConversationTimelinePatch = Partial<Record<ConversationTimelineTableKey, ConversationTimelineTablePatch>>;

export class ConversationTimelineRevisionConflictError extends Error {
  public readonly conversationTimelineRevisionConflict = true;

  public constructor(
    public readonly conversationId: string,
    public readonly tableKey: ConversationTimelineTableKey,
    public readonly recordId: string,
    public readonly expectedRevision: string | null,
    public readonly actualRevision: string | null
  ) {
    super(`Conversation timeline conflict in ${conversationId}/${tableKey}/${recordId}: expected=${expectedRevision ?? 'missing'}, actual=${actualRevision ?? 'missing'}`);
    this.name = 'ConversationTimelineRevisionConflictError';
  }
}

export function isConversationTimelineRevisionConflictError(error: unknown): error is ConversationTimelineRevisionConflictError {
  if (error instanceof ConversationTimelineRevisionConflictError) return true;
  return !!error && typeof error === 'object'
    && (error as { conversationTimelineRevisionConflict?: unknown }).conversationTimelineRevisionConflict === true;
}

export function createConversationTimelinePatch(base: ClientState, next: ClientState): ConversationTimelinePatch {
  const patch: ConversationTimelinePatch = {};
  for (const key of CONVERSATION_TIMELINE_TABLE_KEYS) {
    const baseRecords = recordsFor(base, key);
    const nextRecords = recordsFor(next, key);
    const baseById = uniqueMap(baseRecords, `${key}:base`);
    const nextById = uniqueMap(nextRecords, `${key}:next`);
    const upserts: ConversationTimelineRecordUpsert[] = [];
    const removes: ConversationTimelineRecordRemove[] = [];
    for (const record of nextRecords) {
      const previous = baseById.get(record.id);
      if (!previous) {
        upserts.push({ record: cloneRecord(record), expectedRecordRevision: null });
      } else {
        const expected = createStorageRevision(previous);
        if (createStorageRevision(record) !== expected) {
          upserts.push({ record: cloneRecord(record), expectedRecordRevision: expected });
        }
      }
    }
    for (const record of baseRecords) {
      if (!nextById.has(record.id)) removes.push({ id: record.id, expectedRecordRevision: createStorageRevision(record) });
    }
    if (upserts.length || removes.length) patch[key] = { upserts, removes };
  }
  return patch;
}

export function applyConversationTimelinePatch(
  conversationId: string,
  current: ClientState,
  patch: ConversationTimelinePatch
): { state: ClientState; changed: boolean } {
  let changed = false;
  for (const key of CONVERSATION_TIMELINE_TABLE_KEYS) {
    const tablePatch = patch[key];
    if (!tablePatch) continue;
    const currentRecords = recordsFor(current, key);
    const currentById = uniqueMap(currentRecords, `${conversationId}:${key}:current`);
    const nextById = new Map(currentById);

    for (const upsert of tablePatch.upserts) {
      const existing = nextById.get(upsert.record.id);
      const actual = existing ? createStorageRevision(existing) : null;
      const desired = createStorageRevision(upsert.record);
      if (actual === desired) continue;
      if (actual !== upsert.expectedRecordRevision) {
        throw new ConversationTimelineRevisionConflictError(
          conversationId, key, upsert.record.id, upsert.expectedRecordRevision, actual
        );
      }
      nextById.set(upsert.record.id, cloneRecord(upsert.record));
      changed = true;
    }
    for (const remove of tablePatch.removes) {
      const existing = nextById.get(remove.id);
      if (!existing) continue;
      const actual = createStorageRevision(existing);
      if (actual !== remove.expectedRecordRevision) {
        throw new ConversationTimelineRevisionConflictError(conversationId, key, remove.id, remove.expectedRecordRevision, actual);
      }
      nextById.delete(remove.id);
      changed = true;
    }

    const nextRecords: ConversationTimelineRecord[] = [];
    const emitted = new Set<string>();
    for (const existing of currentRecords) {
      const next = nextById.get(existing.id);
      if (!next) continue;
      nextRecords.push(next);
      emitted.add(next.id);
    }
    for (const upsert of tablePatch.upserts) {
      if (emitted.has(upsert.record.id)) continue;
      const next = nextById.get(upsert.record.id);
      if (!next) continue;
      nextRecords.push(next);
      emitted.add(next.id);
    }
    assignRecords(current, key, nextRecords);
  }
  return { state: current, changed };
}

export function isEmptyConversationTimelinePatch(patch: ConversationTimelinePatch): boolean {
  return Object.keys(patch).length === 0;
}

function recordsFor(state: ClientState, key: ConversationTimelineTableKey): ConversationTimelineRecord[] {
  return state[key] as ConversationTimelineRecord[];
}

function assignRecords(state: ClientState, key: ConversationTimelineTableKey, records: ConversationTimelineRecord[]): void {
  (state as unknown as Record<ClientStateTableKey, ConversationTimelineRecord[]>)[key] = records;
}

function uniqueMap(records: ConversationTimelineRecord[], label: string): Map<string, ConversationTimelineRecord> {
  const result = new Map<string, ConversationTimelineRecord>();
  for (const record of records) {
    if (!record.id.trim() || result.has(record.id)) throw new Error(`Duplicate or empty timeline record id in ${label}: ${record.id}`);
    result.set(record.id, record);
  }
  return result;
}

function cloneRecord(record: ConversationTimelineRecord): ConversationTimelineRecord {
  return JSON.parse(JSON.stringify(record)) as ConversationTimelineRecord;
}
