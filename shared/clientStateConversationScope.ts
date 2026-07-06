import { CLIENT_STATE_TABLE_KEYS } from './clientStateSchema';
import type { ClientState, ClientStateTableKey } from './protocol';

type ClientStateRecord = { id: string; [key: string]: unknown };

export function collectChangedClientStateConversationIds(prev: ClientState, next: ClientState, tableKeys: readonly ClientStateTableKey[] = CLIENT_STATE_TABLE_KEYS): Set<string> {
  const ids = new Set<string>();
  const prevIndex = new ConversationReferenceIndex(prev);
  const nextIndex = new ConversationReferenceIndex(next);

  for (const tableKey of tableKeys) {
    const prevRecords = prev[tableKey] as ClientStateRecord[];
    const nextRecords = next[tableKey] as ClientStateRecord[];
    if (prevRecords === nextRecords) continue;
    if (prevRecords.length === 0 && nextRecords.length === 0) continue;

    const prevById = new Map(prevRecords.map((record) => [record.id, record]));
    const nextById = new Map(nextRecords.map((record) => [record.id, record]));

    for (const record of nextRecords) {
      const old = prevById.get(record.id);
      if (old && (old === record || JSON.stringify(old) === JSON.stringify(record))) continue;
      addRecordConversationIds(ids, tableKey, record, nextIndex);
      if (old) addRecordConversationIds(ids, tableKey, old, prevIndex);
    }

    for (const record of prevRecords) {
      if (nextById.has(record.id)) continue;
      addRecordConversationIds(ids, tableKey, record, prevIndex);
    }
  }

  return ids;
}

class ConversationReferenceIndex {
  private _conversationIdToRelatedConversationIds: Map<string, Set<string>> | undefined;
  private _messageIdToConversationId: Map<string, string> | undefined;
  private _toolCallIdToConversationIds: Map<string, Set<string>> | undefined;
  private _runIdToConversationIds: Map<string, Set<string>> | undefined;
  private _blockIdToConversationId: Map<string, string> | undefined;
  private _checkpointIdToConversationIds: Map<string, Set<string>> | undefined;
  private _projectContextIdToConversationIds: Map<string, Set<string>> | undefined;
  private _shadowRepositoryIdToConversationIds: Map<string, Set<string>> | undefined;
  private _runtimeSnapshotIdToConversationIds: Map<string, Set<string>> | undefined;
  private _invocationIdToConversationIds: Map<string, Set<string>> | undefined;
  private _runPolicyIdToConversationIds: Map<string, Set<string>> | undefined;

  public constructor(private readonly state: ClientState) {}

  public get conversationIdToRelatedConversationIds(): Map<string, Set<string>> {
    if (!this._conversationIdToRelatedConversationIds) {
      const result = new Map<string, Set<string>>();
      for (const conversationIds of this.runIdToConversationIds.values()) {
        for (const conversationId of conversationIds) {
          for (const relatedConversationId of conversationIds) addToSetMap(result, conversationId, relatedConversationId);
        }
      }
      this._conversationIdToRelatedConversationIds = result;
    }
    return this._conversationIdToRelatedConversationIds;
  }

  public get messageIdToConversationId(): Map<string, string> {
    if (!this._messageIdToConversationId) {
      this._messageIdToConversationId = new Map(this.state.messages.map((message) => [message.id, message.conversationId]));
    }
    return this._messageIdToConversationId;
  }

  public get toolCallIdToConversationIds(): Map<string, Set<string>> {
    if (!this._toolCallIdToConversationIds) {
      const result = new Map<string, Set<string>>();
      for (const toolCall of this.state.toolCalls) addOptionalToSetMap(result, toolCall.id, this.messageIdToConversationId.get(toolCall.messageId));
      this._toolCallIdToConversationIds = result;
    }
    return this._toolCallIdToConversationIds;
  }

  public get runIdToConversationIds(): Map<string, Set<string>> {
    if (!this._runIdToConversationIds) {
      const result = new Map<string, Set<string>>();
      for (const link of this.state.agentRunTargetLinks) addToSetMap(result, link.runId, link.conversationId);
      for (const link of this.state.agentRunSourceLinks) {
        addOptionalToSetMap(result, link.runId, link.sourceConversationId);
        addOptionalSetToSetMap(result, link.runId, link.sourceMessageId ? setOf(this.messageIdToConversationId.get(link.sourceMessageId)) : undefined);
        addOptionalSetToSetMap(result, link.runId, link.sourceToolCallId ? this.toolCallIdToConversationIds.get(link.sourceToolCallId) : undefined);
      }
      for (const link of this.state.messageRunLinks) addOptionalToSetMap(result, link.runId, this.messageIdToConversationId.get(link.messageId));
      for (const link of this.state.toolCallRunLinks) addOptionalSetToSetMap(result, link.runId, this.toolCallIdToConversationIds.get(link.toolCallId));
      for (const input of this.state.agentRunInputRevisions) addToSetMap(result, input.runId, input.conversationId);

      let propagated = true;
      while (propagated) {
        propagated = false;
        for (const link of this.state.agentRunSourceLinks) {
          const sourceIds = link.sourceRunId ? result.get(link.sourceRunId) : undefined;
          if (sourceIds) propagated = addOptionalSetToSetMap(result, link.runId, sourceIds) || propagated;
          const runIds = result.get(link.runId);
          if (runIds && link.sourceRunId) propagated = addOptionalSetToSetMap(result, link.sourceRunId, runIds) || propagated;
        }
      }

      this._runIdToConversationIds = result;
    }
    return this._runIdToConversationIds;
  }

  public get blockIdToConversationId(): Map<string, string> {
    if (!this._blockIdToConversationId) {
      this._blockIdToConversationId = new Map(this.state.compressionBlocks.map((block) => [block.id, block.conversationId]));
    }
    return this._blockIdToConversationId;
  }

  public get checkpointIdToConversationIds(): Map<string, Set<string>> {
    if (!this._checkpointIdToConversationIds) {
      const result = new Map<string, Set<string>>();
      for (const checkpoint of this.state.checkpoints) addToSetMap(result, checkpoint.id, checkpoint.conversationId);
      for (const anchor of this.state.checkpointTimelineAnchors) addToSetMap(result, anchor.checkpointId, anchor.conversationId);
      this._checkpointIdToConversationIds = result;
    }
    return this._checkpointIdToConversationIds;
  }

  public get projectContextIdToConversationIds(): Map<string, Set<string>> {
    if (!this._projectContextIdToConversationIds) {
      const result = new Map<string, Set<string>>();
      for (const link of this.state.conversationProjectLinks) addToSetMap(result, link.projectContextId, link.conversationId);
      for (const checkpoint of this.state.checkpoints) addToSetMap(result, checkpoint.projectContextId, checkpoint.conversationId);
      for (const link of this.state.conversationCheckpointRepositoryLinks) addToSetMap(result, link.projectContextId, link.conversationId);
      this._projectContextIdToConversationIds = result;
    }
    return this._projectContextIdToConversationIds;
  }

  public get shadowRepositoryIdToConversationIds(): Map<string, Set<string>> {
    if (!this._shadowRepositoryIdToConversationIds) {
      const result = new Map<string, Set<string>>();
      for (const checkpoint of this.state.checkpoints) addToSetMap(result, checkpoint.shadowRepositoryId, checkpoint.conversationId);
      for (const link of this.state.conversationCheckpointRepositoryLinks) addToSetMap(result, link.shadowRepositoryId, link.conversationId);
      this._shadowRepositoryIdToConversationIds = result;
    }
    return this._shadowRepositoryIdToConversationIds;
  }

  public get runtimeSnapshotIdToConversationIds(): Map<string, Set<string>> {
    if (!this._runtimeSnapshotIdToConversationIds) {
      const result = new Map<string, Set<string>>();
      for (const snapshot of this.state.runtimeContextSnapshots) addOptionalToSetMap(result, snapshot.id, snapshot.conversationId);
      for (const link of this.state.conversationRuntimeContextSnapshotLinks) addToSetMap(result, link.runtimeContextSnapshotId, link.conversationId);
      for (const link of this.state.runRuntimeContextSnapshotLinks) addOptionalSetToSetMap(result, link.runtimeContextSnapshotId, this.runIdToConversationIds.get(link.runId));
      this._runtimeSnapshotIdToConversationIds = result;
    }
    return this._runtimeSnapshotIdToConversationIds;
  }

  public get invocationIdToConversationIds(): Map<string, Set<string>> {
    if (!this._invocationIdToConversationIds) {
      const result = new Map<string, Set<string>>();
      for (const link of this.state.runLlmInvocationLinks) addOptionalSetToSetMap(result, link.invocationId, this.runIdToConversationIds.get(link.runId));
      for (const link of this.state.messageLlmInvocationLinks) addOptionalToSetMap(result, link.invocationId, this.messageIdToConversationId.get(link.messageId));
      for (const link of this.state.compressionBlockLlmInvocationLinks) addOptionalToSetMap(result, link.invocationId, this.blockIdToConversationId.get(link.blockId));
      this._invocationIdToConversationIds = result;
    }
    return this._invocationIdToConversationIds;
  }

  public get runPolicyIdToConversationIds(): Map<string, Set<string>> {
    if (!this._runPolicyIdToConversationIds) {
      const result = new Map<string, Set<string>>();
      for (const link of this.state.runConversationPolicyLinks) addOptionalSetToSetMap(result, link.policyId, this.runIdToConversationIds.get(link.runId));
      for (const link of this.state.runContextPolicyLinks) addOptionalSetToSetMap(result, link.policyId, this.runIdToConversationIds.get(link.runId));
      for (const link of this.state.runDeliveryPolicyLinks) addOptionalSetToSetMap(result, link.policyId, this.runIdToConversationIds.get(link.runId));
      for (const link of this.state.runEditPolicyLinks) addOptionalSetToSetMap(result, link.policyId, this.runIdToConversationIds.get(link.runId));
      this._runPolicyIdToConversationIds = result;
    }
    return this._runPolicyIdToConversationIds;
  }
}

function addRecordConversationIds(ids: Set<string>, tableKey: ClientStateTableKey, record: ClientStateRecord, index: ConversationReferenceIndex): void {
  if (tableKey === 'conversations') {
    addString(ids, record.id);
    addSet(ids, index.conversationIdToRelatedConversationIds.get(record.id));
  }
  addString(ids, stringField(record, 'conversationId'));
  addString(ids, stringField(record, 'sourceConversationId'));
  addString(ids, stringField(record, 'targetConversationId'));

  const messageId = stringField(record, 'messageId');
  if (messageId) addString(ids, index.messageIdToConversationId.get(messageId));
  const sourceMessageId = stringField(record, 'sourceMessageId');
  if (sourceMessageId) addString(ids, index.messageIdToConversationId.get(sourceMessageId));
  const floorMessageId = stringField(record, 'floorMessageId');
  if (floorMessageId) addString(ids, index.messageIdToConversationId.get(floorMessageId));

  const toolCallId = stringField(record, 'toolCallId');
  if (toolCallId) addSet(ids, index.toolCallIdToConversationIds.get(toolCallId));
  const sourceToolCallId = stringField(record, 'sourceToolCallId');
  if (sourceToolCallId) addSet(ids, index.toolCallIdToConversationIds.get(sourceToolCallId));

  const runId = stringField(record, 'runId');
  if (runId) addSet(ids, index.runIdToConversationIds.get(runId));
  const sourceRunId = stringField(record, 'sourceRunId');
  if (sourceRunId) addSet(ids, index.runIdToConversationIds.get(sourceRunId));

  const blockId = stringField(record, 'blockId');
  if (blockId) addString(ids, index.blockIdToConversationId.get(blockId));
  const checkpointId = stringField(record, 'checkpointId');
  if (checkpointId) addSet(ids, index.checkpointIdToConversationIds.get(checkpointId));
  const projectContextId = stringField(record, 'projectContextId');
  if (projectContextId) addSet(ids, index.projectContextIdToConversationIds.get(projectContextId));
  const shadowRepositoryId = stringField(record, 'shadowRepositoryId');
  if (shadowRepositoryId) addSet(ids, index.shadowRepositoryIdToConversationIds.get(shadowRepositoryId));
  const runtimeContextSnapshotId = stringField(record, 'runtimeContextSnapshotId');
  if (runtimeContextSnapshotId) addSet(ids, index.runtimeSnapshotIdToConversationIds.get(runtimeContextSnapshotId));
  const invocationId = stringField(record, 'invocationId');
  if (invocationId) addSet(ids, index.invocationIdToConversationIds.get(invocationId));
  const policyId = stringField(record, 'policyId');
  if (policyId) addSet(ids, index.runPolicyIdToConversationIds.get(policyId));

  if (tableKey === 'toolCalls') addSet(ids, index.toolCallIdToConversationIds.get(record.id));
  if (tableKey === 'agentRuns') addSet(ids, index.runIdToConversationIds.get(record.id));
  if (tableKey === 'compressionBlocks') addString(ids, index.blockIdToConversationId.get(record.id));
  if (tableKey === 'checkpoints') addSet(ids, index.checkpointIdToConversationIds.get(record.id));
  if (tableKey === 'projectContexts') addSet(ids, index.projectContextIdToConversationIds.get(record.id));
  if (tableKey === 'shadowRepositories') addSet(ids, index.shadowRepositoryIdToConversationIds.get(record.id));
  if (tableKey === 'runtimeContextSnapshots') addSet(ids, index.runtimeSnapshotIdToConversationIds.get(record.id));
  if (tableKey === 'llmInvocations') addSet(ids, index.invocationIdToConversationIds.get(record.id));
  if (tableKey === 'runConversationPolicies' || tableKey === 'runContextPolicies' || tableKey === 'runDeliveryPolicies' || tableKey === 'runEditPolicies') {
    addSet(ids, index.runPolicyIdToConversationIds.get(record.id));
  }
}

function addString(ids: Set<string>, value: string | undefined): void {
  if (value) ids.add(value);
}

function addSet(ids: Set<string>, values: ReadonlySet<string> | undefined): void {
  for (const value of values ?? []) ids.add(value);
}

function stringField(record: ClientStateRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): boolean {
  let values = map.get(key);
  if (!values) {
    values = new Set();
    map.set(key, values);
  }
  const before = values.size;
  values.add(value);
  return values.size !== before;
}

function addOptionalToSetMap(map: Map<string, Set<string>>, key: string, value: string | undefined): boolean {
  return value ? addToSetMap(map, key, value) : false;
}

function addOptionalSetToSetMap(map: Map<string, Set<string>>, key: string, values: ReadonlySet<string> | undefined): boolean {
  let changed = false;
  for (const value of values ?? []) changed = addToSetMap(map, key, value) || changed;
  return changed;
}

function setOf(value: string | undefined): Set<string> | undefined {
  return value ? new Set([value]) : undefined;
}
