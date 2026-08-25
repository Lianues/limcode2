import { createEmptyClientState } from '../../shared/clientStateSchema';
import {
  clientStateRecordConversationIds,
  type ClientStateRecord
} from '../../shared/clientStateConversationScope';
import type { ClientState } from '../../shared/protocol';
import {
  CLIENT_STATE_SKELETON_STORE_KEYS,
  type ClientStateSkeletonStoreKey
} from '../capabilities/vscodeStorage/clientStateSkeletonStores';
import { workspaceRuntimeState } from './sharedConfigurationState';

interface ConversationReferenceMaps {
  agentIds: Map<string, Set<string>>;
  answerIds: Map<string, Set<string>>;
}

/**
 * 提取一个 Conversation 在 workspace runtime skeleton 中拥有或依赖的记录图。
 * shared-configuration 表会先由 workspaceRuntimeState 清空，因此不会被复制回 workspace scope。
 */
export function conversationWorkspaceSkeletonSlice(state: ClientState, conversationId: string): ClientState {
  const workspace = workspaceRuntimeState(state);
  const references = conversationReferenceMaps(workspace);
  const result = createEmptyClientState();
  for (const key of CLIENT_STATE_SKELETON_STORE_KEYS) {
    const records = recordsFor(workspace, key).filter((record) => {
      if (key === 'conversationBranchLinks') {
        // Branch Link 需要两端 Conversation 实体；只挂载单个 foreign Conversation 时无法完整 hydrate。
        // 不把半边关系放进本地 CAS base，避免下一次保存把源 scope 中仍有效的 Link 误删。
        return stringField(record, 'sourceConversationId') === conversationId
          && stringField(record, 'targetConversationId') === conversationId;
      }
      return recordConversationIds(workspace, key, record, references).has(conversationId);
    });
    assignRecords(result, key, records);
  }
  return result;
}

/**
 * 把当前 world 的 workspace skeleton 按 Conversation owner scope 分片。
 * 无 Conversation 归属的 runtime 记录留在 default scope；被多个 scope 引用的独立依赖记录
 * 会复制到各自分片，关系仍通过独立 Link 表达。
 */
export function partitionWorkspaceSkeletonByConversationOwner(
  state: ClientState,
  ownerScopeByConversationId: ReadonlyMap<string, string>,
  defaultWorkspaceScopeKey: string
): Map<string, ClientState> {
  const workspace = workspaceRuntimeState(state);
  const references = conversationReferenceMaps(workspace);
  const result = new Map<string, ClientState>();
  const ensure = (scopeKey: string): ClientState => {
    const existing = result.get(scopeKey);
    if (existing) return existing;
    const created = createEmptyClientState();
    result.set(scopeKey, created);
    return created;
  };
  ensure(defaultWorkspaceScopeKey);

  for (const key of CLIENT_STATE_SKELETON_STORE_KEYS) {
    for (const record of recordsFor(workspace, key)) {
      const conversationIds = recordConversationIds(workspace, key, record, references);
      const scopeKeys = conversationIds.size > 0
        ? new Set([...conversationIds].map((id) => ownerScopeByConversationId.get(id) ?? defaultWorkspaceScopeKey))
        : new Set([defaultWorkspaceScopeKey]);
      for (const scopeKey of scopeKeys) appendRecord(ensure(scopeKey), key, record);
    }
  }
  return result;
}

export function mergeWorkspaceSkeletonSlices(base: ClientState, incoming: ClientState): ClientState {
  const result = workspaceRuntimeState(base);
  for (const key of CLIENT_STATE_SKELETON_STORE_KEYS) {
    const records = recordsFor(result, key).map(cloneRecord);
    const indexById = new Map(records.map((record, index) => [record.id, index]));
    for (const record of recordsFor(workspaceRuntimeState(incoming), key)) {
      const clone = cloneRecord(record);
      const index = indexById.get(clone.id);
      if (index === undefined) {
        indexById.set(clone.id, records.length);
        records.push(clone);
      } else {
        records[index] = clone;
      }
    }
    assignRecords(result, key, records);
  }
  return result;
}

function conversationReferenceMaps(state: ClientState): ConversationReferenceMaps {
  const agentIds = new Map<string, Set<string>>();
  const answerIds = new Map<string, Set<string>>();

  for (const link of state.agentConversationLinks) addReference(agentIds, link.agentId, link.conversationId);
  for (const selection of state.conversationAgentSelections) addReference(agentIds, selection.agentId, selection.conversationId);

  for (const link of state.agentAnswerSubmissionLinks) {
    if (link.submitterConversationId) {
      addReference(answerIds, link.answerId, link.submitterConversationId);
      if (link.submitterAgentId) addReference(agentIds, link.submitterAgentId, link.submitterConversationId);
    }
  }
  for (const link of state.agentAnswerTargetLinks) {
    if (link.targetConversationId) {
      addReference(answerIds, link.answerId, link.targetConversationId);
      if (link.targetAgentId) addReference(agentIds, link.targetAgentId, link.targetConversationId);
    }
  }
  return { agentIds, answerIds };
}

function recordConversationIds(
  state: ClientState,
  key: ClientStateSkeletonStoreKey,
  record: ClientStateRecord,
  references: ConversationReferenceMaps
): Set<string> {
  if (key === 'conversations') return new Set([record.id]);
  if (key === 'conversationBranchLinks') {
    return new Set([
      stringField(record, 'sourceConversationId'),
      stringField(record, 'targetConversationId')
    ].filter((value): value is string => !!value));
  }
  const directConversationId = stringField(record, 'conversationId');
  const ids = directConversationId
    ? new Set([directConversationId])
    : clientStateRecordConversationIds(state, key, record);
  if (key === 'agents') addAll(ids, references.agentIds.get(record.id));
  if (key === 'agentAnswers') addAll(ids, references.answerIds.get(record.id));
  if (key === 'agentAnswerSubmissionLinks') {
    const conversationId = stringField(record, 'submitterConversationId');
    if (conversationId) ids.add(conversationId);
    addAll(ids, references.answerIds.get(stringField(record, 'answerId') ?? ''));
  }
  if (key === 'agentAnswerTargetLinks') {
    const conversationId = stringField(record, 'targetConversationId');
    if (conversationId) ids.add(conversationId);
    addAll(ids, references.answerIds.get(stringField(record, 'answerId') ?? ''));
  }
  return ids;
}

function addReference(map: Map<string, Set<string>>, recordId: string, conversationId: string): void {
  const ids = map.get(recordId) ?? new Set<string>();
  ids.add(conversationId);
  map.set(recordId, ids);
}

function addAll(target: Set<string>, values: ReadonlySet<string> | undefined): void {
  for (const value of values ?? []) target.add(value);
}

function stringField(record: ClientStateRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

function recordsFor(state: ClientState, key: ClientStateSkeletonStoreKey): ClientStateRecord[] {
  return state[key] as ClientStateRecord[];
}

function assignRecords(state: ClientState, key: ClientStateSkeletonStoreKey, records: ClientStateRecord[]): void {
  (state as unknown as Record<ClientStateSkeletonStoreKey, ClientStateRecord[]>)[key] = records.map(cloneRecord);
}

function appendRecord(state: ClientState, key: ClientStateSkeletonStoreKey, record: ClientStateRecord): void {
  const records = recordsFor(state, key);
  if (!records.some((candidate) => candidate.id === record.id)) records.push(cloneRecord(record));
}

function cloneRecord<T extends ClientStateRecord>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}
