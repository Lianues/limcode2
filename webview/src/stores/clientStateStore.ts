import { reactive } from 'vue';
import {
  CLIENT_STATE_TABLES,
  copyClientStateTables,
  createEmptyClientState,
  GENERIC_CLIENT_MUTATION_APPLY_BY_KIND,
  GENERIC_CLIENT_PATCH_APPLY_BY_KIND,
  GLOBAL_CLIENT_STATE_TABLE_KEYS,
  type ClientStateMutationApplySpec,
  type ClientStateMutationPathSegment,
  type ClientStateSortSpec
} from '@shared/clientStateRegistry';
import {
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationIdFromClientStateStreamId,
  type ClientPatchOp,
  type ClientState,
  type ClientStateTableKey
} from '@shared/protocol';

interface ClientStateStore extends ClientState {
  /** 每个 state stream 当前已应用到的顺序号，用于判断 patch 是否断链。 */
  streamSeqs: Record<string, number>;
  currentConversationId: string;
  showHiddenConversations: boolean;
}

export const clientState = reactive<ClientStateStore>({
  ...createEmptyClientState(),
  streamSeqs: {},
  currentConversationId: '',
  showHiddenConversations: false
});

export function applyClientSnapshot(streamId: string, streamSeq: number, state: ClientState): void {
  clientState.streamSeqs[streamId] = streamSeq;
  if (streamId === GLOBAL_CLIENT_STATE_STREAM_ID) {
    applyGlobalSnapshot(state);
    ensureCurrentConversation();
    return;
  }

  const conversationId = conversationIdFromClientStateStreamId(streamId) ?? state.conversations[0]?.id ?? state.messages[0]?.conversationId;
  if (!conversationId) return;
  replaceConversationState(conversationId, state);
  ensureCurrentConversation();
}

export function applyClientPatch(streamId: string, streamSeq: number, patches: ClientPatchOp[]): boolean {
  const currentStreamSeq = clientState.streamSeqs[streamId] ?? 0;
  if (streamSeq !== currentStreamSeq + 1) return false;
  for (const patch of patches) applyClientPatchOp(patch);
  clientState.streamSeqs[streamId] = streamSeq;
  ensureCurrentConversation();
  return true;
}

function applyGlobalSnapshot(state: ClientState): void {
  copyClientStateTables(clientState, state, GLOBAL_CLIENT_STATE_TABLE_KEYS);
}

function applyClientPatchOp(patch: ClientPatchOp): void {
  if (applyGenericClientPatchOp(patch)) return;
  if (applyGenericClientMutationPatchOp(patch)) return;

  switch (patch.kind) {
    case 'conversation.remove': removeConversation(patch.id); break;
  }
}

function applyGenericClientPatchOp(patch: ClientPatchOp): boolean {
  const operation = GENERIC_CLIENT_PATCH_APPLY_BY_KIND[patch.kind];
  if (!operation) return false;

  const list = clientState[operation.tableKey] as Array<{ id: string }>;
  if (operation.operation === 'remove') {
    removeRegisteredRecord(operation.tableKey, (patch as { id: string }).id);
    return true;
  }

  const payloadField = operation.payloadField;
  if (!payloadField) return false;
  const record = (patch as unknown as Record<string, unknown>)[payloadField] as { id: string } | undefined;
  if (!record) return false;
  upsert(list, record);
  sortRegisteredTable(operation.tableKey);
  return true;
}

function applyGenericClientMutationPatchOp(patch: ClientPatchOp): boolean {
  const operation = GENERIC_CLIENT_MUTATION_APPLY_BY_KIND[patch.kind];
  if (!operation) return false;

  const record = (clientState[operation.tableKey] as ClientStateMutableRecord[]).find((item) => item.id === (patch as { id: string }).id);
  if (!record) return true;

  applyMutation(record, patch as unknown as Record<string, unknown>, operation.apply);
  return true;
}


type ClientStatePathKey = string | number;

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
    list.splice(index, 0, patch[apply.itemField]);
  }
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



type ClientStateMutableRecord = { id: string; [key: string]: unknown };

function removeRegisteredRecord(tableKey: ClientStateTableKey, id: string, visited = new Set<string>()): void {
  const visitKey = `${tableKey}:${id}`;
  if (visited.has(visitKey)) return;
  visited.add(visitKey);

  const spec = CLIENT_STATE_TABLES[tableKey].clientSync;
  for (const cascade of spec.cascadeRemove ?? []) {
    const childRecords = clientState[cascade.table] as ClientStateMutableRecord[];
    const childIds = childRecords
      .filter((record) => record[cascade.foreignKey] === id)
      .map((record) => record.id);

    if ('cascade' in cascade && cascade.cascade) {
      for (const childId of childIds) removeRegisteredRecord(cascade.table, childId, visited);
    } else {
      removeWhere(childRecords, (record) => record[cascade.foreignKey] === id);
    }
  }

  removeById(clientState[tableKey] as ClientStateMutableRecord[], id);
}

function sortRegisteredTable(tableKey: ClientStateTableKey): void {
  const orderBy = CLIENT_STATE_TABLES[tableKey].clientSync.orderBy;
  if (!orderBy || orderBy.length === 0) return;
  (clientState[tableKey] as ClientStateMutableRecord[]).sort((left, right) => compareRecords(left, right, orderBy));
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

function removeWhere<T>(list: T[], predicate: (item: T) => boolean): void {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) list.splice(index, 1);
  }
}





function replaceConversationState(conversationId: string, state: ClientState): void {
  const previousMessageIds = new Set(clientState.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id));
  const previousToolCallIds = new Set(clientState.toolCalls.filter((toolCall) => previousMessageIds.has(toolCall.messageId)).map((toolCall) => toolCall.id));
  const runIdsToReplace = new Set([...relatedRunIdsForConversation(conversationId), ...state.agentRuns.map((run) => run.id)]);

  upsertMany(clientState.conversations, state.conversations);
  clientState.conversationReuseLinks = [...clientState.conversationReuseLinks.filter((link) => link.conversationId !== conversationId), ...state.conversationReuseLinks];
  clientState.conversationBranchLinks = [...clientState.conversationBranchLinks.filter((link) => link.sourceConversationId !== conversationId && link.targetConversationId !== conversationId), ...state.conversationBranchLinks];
  clientState.messages = [...clientState.messages.filter((message) => message.conversationId !== conversationId), ...state.messages].sort((a, b) => a.seq - b.seq);
  clientState.messageRevisions = [...clientState.messageRevisions.filter((revision) => revision.conversationId !== conversationId), ...state.messageRevisions].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  clientState.messageCurrentRevisionLinks = [...clientState.messageCurrentRevisionLinks.filter((link) => !previousMessageIds.has(link.messageId)), ...state.messageCurrentRevisionLinks];
  clientState.toolCalls = [...clientState.toolCalls.filter((toolCall) => !previousMessageIds.has(toolCall.messageId)), ...state.toolCalls];
  clientState.toolCallEvents = [...clientState.toolCallEvents.filter((event) => !previousToolCallIds.has(event.toolCallId)), ...state.toolCallEvents].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));

  removeRunScopedState(runIdsToReplace);
  upsertMany(clientState.agentRuns, state.agentRuns);
  upsertMany(clientState.agentRunSourceLinks, state.agentRunSourceLinks);
  upsertMany(clientState.agentRunTargetLinks, state.agentRunTargetLinks);
  upsertMany(clientState.messageRunLinks, state.messageRunLinks);
  upsertMany(clientState.toolCallRunLinks, state.toolCallRunLinks);
  upsertMany(clientState.runConversationPolicies, state.runConversationPolicies);
  upsertMany(clientState.runContextPolicies, state.runContextPolicies);
  upsertMany(clientState.runDeliveryPolicies, state.runDeliveryPolicies);
  upsertMany(clientState.runEditPolicies, state.runEditPolicies);
  upsertMany(clientState.runModeLinks, state.runModeLinks);
  upsertMany(clientState.runSystemPromptLinks, state.runSystemPromptLinks);
  upsertMany(clientState.runModelProfileLinks, state.runModelProfileLinks);
  upsertMany(clientState.runToolPolicyLinks, state.runToolPolicyLinks);
  upsertMany(clientState.runApprovalPolicyLinks, state.runApprovalPolicyLinks);
  upsertMany(clientState.runConversationPolicyLinks, state.runConversationPolicyLinks);
  upsertMany(clientState.runContextPolicyLinks, state.runContextPolicyLinks);
  upsertMany(clientState.runDeliveryPolicyLinks, state.runDeliveryPolicyLinks);
  upsertMany(clientState.runEditPolicyLinks, state.runEditPolicyLinks);
  upsertMany(clientState.agentRunInputRevisions, state.agentRunInputRevisions);
}

function removeConversation(conversationId: string): void {
  const messageIds = clientState.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id);
  const runIds = relatedRunIdsForConversation(conversationId);
  removeById(clientState.conversations, conversationId);
  clientState.conversationReuseLinks = clientState.conversationReuseLinks.filter((link) => link.conversationId !== conversationId);
  clientState.conversationBranchLinks = clientState.conversationBranchLinks.filter((link) => link.sourceConversationId !== conversationId && link.targetConversationId !== conversationId);
  clientState.agentConversationLinks = clientState.agentConversationLinks.filter((item) => item.conversationId !== conversationId);
  for (const messageId of messageIds) removeRegisteredRecord('messages', messageId);
  removeRunScopedState(runIds);
  if (clientState.currentConversationId === conversationId) clientState.currentConversationId = clientState.conversations[0]?.id ?? '';
}


function removeRunScopedState(runIds: ReadonlySet<string>): void {
  if (runIds.size === 0) return;
  clientState.agentRunSourceLinks = clientState.agentRunSourceLinks.filter((link) => !runIds.has(link.runId));
  clientState.agentRunTargetLinks = clientState.agentRunTargetLinks.filter((link) => !runIds.has(link.runId));
  clientState.messageRunLinks = clientState.messageRunLinks.filter((link) => !runIds.has(link.runId));
  clientState.toolCallRunLinks = clientState.toolCallRunLinks.filter((link) => !runIds.has(link.runId));
  clientState.runModeLinks = clientState.runModeLinks.filter((link) => !runIds.has(link.runId));
  clientState.runSystemPromptLinks = clientState.runSystemPromptLinks.filter((link) => !runIds.has(link.runId));
  clientState.runModelProfileLinks = clientState.runModelProfileLinks.filter((link) => !runIds.has(link.runId));
  clientState.runToolPolicyLinks = clientState.runToolPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.runApprovalPolicyLinks = clientState.runApprovalPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.runConversationPolicyLinks = clientState.runConversationPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.runContextPolicyLinks = clientState.runContextPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.runDeliveryPolicyLinks = clientState.runDeliveryPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.runEditPolicyLinks = clientState.runEditPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.agentRunInputRevisions = clientState.agentRunInputRevisions.filter((inputRevision) => !runIds.has(inputRevision.runId));
}


function relatedRunIdsForConversation(conversationId: string): Set<string> {
  const messageIds = new Set(clientState.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id));
  const toolCallIds = new Set(clientState.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId)).map((toolCall) => toolCall.id));
  const runIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const add = (id: string | undefined): void => {
      if (!id || runIds.has(id)) return;
      runIds.add(id);
      changed = true;
    };
    for (const link of clientState.agentRunTargetLinks) if (link.conversationId === conversationId || runIds.has(link.runId)) add(link.runId);
    for (const link of clientState.agentRunSourceLinks) {
      if (link.sourceConversationId === conversationId || (link.sourceMessageId && messageIds.has(link.sourceMessageId)) || (link.sourceToolCallId && toolCallIds.has(link.sourceToolCallId)) || (link.sourceRunId && runIds.has(link.sourceRunId)) || runIds.has(link.runId)) add(link.runId);
    }
    for (const link of clientState.messageRunLinks) if (messageIds.has(link.messageId) || runIds.has(link.runId)) add(link.runId);
    for (const link of clientState.toolCallRunLinks) if (toolCallIds.has(link.toolCallId) || runIds.has(link.runId)) add(link.runId);
  }
  return runIds;
}

function ensureCurrentConversation(): void {
  const hasCurrent = !!clientState.currentConversationId && clientState.conversations.some((conversation) => conversation.id === clientState.currentConversationId);
  if (!hasCurrent) {
    clientState.currentConversationId = clientState.conversations.find((conversation) => conversation.id === 'default')?.id ?? clientState.conversations[0]?.id ?? '';
  }
}

function upsertMany<T extends { id: string }>(list: T[], items: T[]): void {
  for (const item of items) upsert(list, item);
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) list[index] = item;
  else list.push(item);
}

function removeById<T extends { id: string }>(list: T[], id: string): void {
  const index = list.findIndex((candidate) => candidate.id === id);
  if (index >= 0) list.splice(index, 1);
}
