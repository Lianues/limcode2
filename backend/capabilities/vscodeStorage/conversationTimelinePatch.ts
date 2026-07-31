import type { ClientState, ClientStateTableKey, MessageRecord } from '../../../shared/protocol';
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
export type ConversationTimelineCanonicalRecords = Partial<Record<ConversationTimelineTableKey, ConversationTimelineRecord[]>>;

export interface ConversationTimelinePatchApplyResult {
  state: ClientState;
  changed: boolean;
  /** 仅包含真正修改 canonical timeline 的操作；被幂等命中或 stale-dominated 的 upsert 不在其中。 */
  acceptedPatch: ConversationTimelinePatch;
  /** 本地 upsert 被 canonical 记录压制时，用于把持久化 ACK 对齐到实际磁盘版本。 */
  canonicalRecords: ConversationTimelineCanonicalRecords;
}

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
): ConversationTimelinePatchApplyResult {
  let changed = false;
  const acceptedPatch: ConversationTimelinePatch = {};
  const canonicalRecords: ConversationTimelineCanonicalRecords = {};
  for (const key of CONVERSATION_TIMELINE_TABLE_KEYS) {
    const tablePatch = patch[key];
    if (!tablePatch) continue;
    const currentRecords = recordsFor(current, key);
    const currentById = uniqueMap(currentRecords, `${conversationId}:${key}:current`);
    const nextById = new Map(currentById);
    const acceptedUpserts: ConversationTimelineRecordUpsert[] = [];
    const acceptedRemoves: ConversationTimelineRecordRemove[] = [];
    const tableCanonicalRecords: ConversationTimelineRecord[] = [];

    for (const upsert of tablePatch.upserts) {
      const existing = nextById.get(upsert.record.id);
      const actual = existing ? createStorageRevision(existing) : null;
      const desired = createStorageRevision(upsert.record);
      if (actual === desired) continue;
      if (existing && isStaleMessageUpsertDominatedByCurrent(key, existing, upsert.record)) {
        tableCanonicalRecords.push(cloneRecord(existing));
        continue;
      }
      if (actual !== upsert.expectedRecordRevision) {
        throw new ConversationTimelineRevisionConflictError(
          conversationId, key, upsert.record.id, upsert.expectedRecordRevision, actual
        );
      }
      nextById.set(upsert.record.id, cloneRecord(upsert.record));
      acceptedUpserts.push({
        record: cloneRecord(upsert.record),
        expectedRecordRevision: upsert.expectedRecordRevision
      });
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
      acceptedRemoves.push({ ...remove });
      changed = true;
    }

    if (acceptedUpserts.length > 0 || acceptedRemoves.length > 0) {
      acceptedPatch[key] = { upserts: acceptedUpserts, removes: acceptedRemoves };
    }
    if (tableCanonicalRecords.length > 0) canonicalRecords[key] = tableCanonicalRecords;

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
  return { state: current, changed, acceptedPatch, canonicalRecords };
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

function isStaleMessageUpsertDominatedByCurrent(
  key: ConversationTimelineTableKey,
  current: ConversationTimelineRecord,
  desired: ConversationTimelineRecord
): boolean {
  if (key !== 'messages') return false;
  const currentMessage = current as MessageRecord;
  const desiredMessage = desired as MessageRecord;
  if (currentMessage.id !== desiredMessage.id
    || currentMessage.conversationId !== desiredMessage.conversationId
    || currentMessage.role !== desiredMessage.role
    || currentMessage.seq !== desiredMessage.seq) {
    return false;
  }

  // 多窗口/延迟 flush 下，旧窗口可能仍试图保存较早的 streaming 片段。
  // 已终态消息或更长的 streaming 前缀代表磁盘上已经有更新的同一模型输出，不能让旧片段制造冲突或回退内容。
  if (desiredMessage.status === 'streaming' && currentMessage.status !== 'streaming') return true;
  if (desiredMessage.status === 'streaming' && currentMessage.status === 'streaming') {
    const currentText = plainTextContent(currentMessage);
    const desiredText = plainTextContent(desiredMessage);
    return !!desiredText && currentText.length >= desiredText.length && currentText.startsWith(desiredText);
  }
  return false;
}

function plainTextContent(message: MessageRecord): string {
  return message.content.parts
    .map((part) => 'text' in part && part.thought !== true ? part.text : '')
    .join('');
}

function cloneRecord(record: ConversationTimelineRecord): ConversationTimelineRecord {
  return JSON.parse(JSON.stringify(record)) as ConversationTimelineRecord;
}
