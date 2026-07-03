import {
  isFunctionCallPart,
  isFunctionResponsePart,
  TERMINAL_TOOL_CALL_STATUSES,
  type ClientState,
  type FunctionCallPart,
  type FunctionResponsePart,
  type MessageContent,
  type MessageRecord,
  type ToolCallRecord
} from '../../shared/protocol';

const MESSAGE_SEQ_STEP = 100_000;
const BACKFILL_RESPONSE_MESSAGE = '工具调用在对话无状态加载时没有找到对应响应，已自动补充兜底响应。原工具执行结果不可用；如仍需要结果，请重新执行相关操作。';

export interface ToolResponseBackfillResult {
  state: ClientState;
  addedCount: number;
}

interface PendingToolCall {
  message: MessageRecord;
  partIndex: number;
  part: FunctionCallPart;
  ids: readonly string[];
  toolCall?: ToolCallRecord;
  resolved: boolean;
}

interface BackfilledMessage {
  sourceMessageId: string;
  message: MessageRecord;
}

export function backfillMissingToolResponsesForStatelessLoad(
  state: ClientState,
  conversationId: string,
  now = Date.now()
): ToolResponseBackfillResult {
  const messages = state.messages
    .filter((message) => message.conversationId === conversationId)
    .sort(compareMessages);
  if (messages.length === 0) return { state, addedCount: 0 };

  const pending = collectUnresolvedToolCalls(state, messages);
  if (pending.length === 0) return { state, addedCount: 0 };

  const next: ClientState = {
    ...state,
    messages: [...state.messages],
    messageRevisions: [...state.messageRevisions],
    messageCurrentRevisionLinks: [...state.messageCurrentRevisionLinks],
    toolCalls: backfillInterruptedToolCallRecords(state.toolCalls, pending, now),
    messageRunLinks: [...state.messageRunLinks]
  };

  const existingMessageIds = new Set(next.messages.map((message) => message.id));
  const existingRevisionIds = new Set(next.messageRevisions.map((revision) => revision.id));
  const existingRevisionLinkIds = new Set(next.messageCurrentRevisionLinks.map((link) => link.id));
  const backfilled = pending.map((call, index) => {
    const responseMessage = createBackfilledResponseMessage(call, conversationId, existingMessageIds, index);
    const revisionId = uniqueId(existingRevisionIds, `rev-${responseMessage.id}`);
    const revisionLinkId = uniqueId(existingRevisionLinkIds, `mcr-${responseMessage.id}`);
    const content = responseMessage.content;

    next.messageRevisions.push({
      id: revisionId,
      messageId: responseMessage.id,
      conversationId,
      content,
      createdAt: responseMessage.createdAt,
      reason: 'system'
    });
    next.messageCurrentRevisionLinks.push({
      id: revisionLinkId,
      messageId: responseMessage.id,
      revisionId
    });

    return { sourceMessageId: call.message.id, message: responseMessage };
  });

  next.messages = mergeBackfilledMessagesWithSeq(next.messages, conversationId, messages, backfilled);
  addBackfilledRunLinks(next, pending, backfilled, now);

  return { state: next, addedCount: backfilled.length };
}

function collectUnresolvedToolCalls(state: ClientState, messages: readonly MessageRecord[]): PendingToolCall[] {
  const toolCallsByMessage = groupToolCallsByMessage(state.toolCalls);
  const usedToolCallIds = new Set<string>();
  const pending: PendingToolCall[] = [];

  messages.forEach((message) => {
    message.content.parts.forEach((part, partIndex) => {
      if (isFunctionCallPart(part)) {
        const toolCall = findToolCallForPart(toolCallsByMessage.get(message.id) ?? [], part, usedToolCallIds);
        if (toolCall) usedToolCallIds.add(toolCall.id);
        pending.push({
          message,
          partIndex,
          part,
          ids: toolCallIds(part, toolCall),
          toolCall,
          resolved: false
        });
        return;
      }

      if (isFunctionResponsePart(part)) consumeResponse(pending, part);
    });
  });

  return pending.filter((call) => !call.resolved);
}

function consumeResponse(pending: PendingToolCall[], part: FunctionResponsePart): void {
  const responseId = normalizeId(part.id);
  const name = part.functionResponse.name;
  const match = responseId
    ? pending.find((call) => !call.resolved && call.ids.includes(responseId))
      ?? pending.find((call) => !call.resolved && call.ids.length === 0 && call.part.functionCall.name === name)
    : pending.find((call) => !call.resolved && call.part.functionCall.name === name);
  if (match) match.resolved = true;
}

function groupToolCallsByMessage(toolCalls: readonly ToolCallRecord[]): Map<string, ToolCallRecord[]> {
  const grouped = new Map<string, ToolCallRecord[]>();
  for (const toolCall of toolCalls) {
    const list = grouped.get(toolCall.messageId) ?? [];
    list.push(toolCall);
    grouped.set(toolCall.messageId, list);
  }
  return grouped;
}

function findToolCallForPart(
  candidates: readonly ToolCallRecord[],
  part: FunctionCallPart,
  usedToolCallIds: ReadonlySet<string>
): ToolCallRecord | undefined {
  const partId = normalizeId(part.id);
  const unused = candidates.filter((candidate) => !usedToolCallIds.has(candidate.id));
  if (partId) {
    const exact = unused.find((candidate) => candidate.id === partId || candidate.functionCallId === partId);
    if (exact) return exact;
  }

  const argsJson = safeJson(part.functionCall.args);
  return unused.find((candidate) => candidate.name === part.functionCall.name && candidate.args === argsJson)
    ?? unused.find((candidate) => candidate.name === part.functionCall.name);
}

function toolCallIds(part: FunctionCallPart, toolCall: ToolCallRecord | undefined): string[] {
  return uniqueStrings([
    normalizeId(part.id),
    normalizeId(toolCall?.functionCallId),
    normalizeId(toolCall?.id)
  ]);
}

function backfillInterruptedToolCallRecords(
  toolCalls: readonly ToolCallRecord[],
  pending: readonly PendingToolCall[],
  now: number
): ToolCallRecord[] {
  const pendingIds = new Set(pending.map((call) => call.toolCall?.id).filter((id): id is string => !!id));
  if (pendingIds.size === 0) return [...toolCalls];

  return toolCalls.map((toolCall) => {
    if (!pendingIds.has(toolCall.id) || TERMINAL_TOOL_CALL_STATUSES.has(toolCall.status)) return toolCall;
    return {
      ...toolCall,
      status: 'error',
      error: toolCall.error ?? BACKFILL_RESPONSE_MESSAGE,
      updatedAt: now
    };
  });
}

function createBackfilledResponseMessage(
  call: PendingToolCall,
  conversationId: string,
  existingMessageIds: Set<string>,
  index: number
): MessageRecord {
  const messageId = uniqueId(existingMessageIds, `m-backfill-${safeId(primaryIdentity(call) ?? `${call.message.id}-${call.partIndex}-${index}`)}`);
  const content: MessageContent = {
    role: 'user',
    parts: [{
      ...(call.part.id ? { id: call.part.id } : {}),
      functionResponse: {
        name: call.part.functionCall.name,
        response: responsePayload(call)
      }
    }]
  };

  return {
    id: messageId,
    conversationId,
    role: 'user',
    content,
    status: hasRecoverableToolResult(call) ? 'complete' : 'error',
    createdAt: call.message.createdAt,
    seq: 0
  };
}

function responsePayload(call: PendingToolCall): Record<string, unknown> {
  if (hasRecoverableToolResult(call)) {
    return {
      ok: call.toolCall.status === 'success',
      status: call.toolCall.status,
      recovered: true,
      message: '工具响应消息缺失，已从已保存的工具结果恢复兜底响应。',
      result: call.toolCall.result
    };
  }

  const toolCall = call.toolCall;
  return {
    ok: false,
    status: 'error',
    recovered: true,
    interrupted: true,
    message: BACKFILL_RESPONSE_MESSAGE,
    error: toolCall?.error ?? BACKFILL_RESPONSE_MESSAGE,
    ...(primaryIdentity(call) ? { toolCallId: primaryIdentity(call) } : {})
  };
}

function hasRecoverableToolResult(call: PendingToolCall): call is PendingToolCall & { toolCall: ToolCallRecord & { status: 'success' | 'warning'; result: unknown } } {
  const toolCall = call.toolCall;
  return (toolCall?.status === 'success' || toolCall?.status === 'warning') && toolCall.result !== undefined;
}

function mergeBackfilledMessagesWithSeq(
  allMessages: readonly MessageRecord[],
  conversationId: string,
  existingConversationMessages: readonly MessageRecord[],
  backfilled: readonly BackfilledMessage[]
): MessageRecord[] {
  const insertionsByMessageId = groupBackfilledMessages(backfilled);
  const canUseGaps = existingConversationMessages.every((message, index) => {
    const insertions = insertionsByMessageId.get(message.id) ?? [];
    if (insertions.length === 0) return true;
    const next = existingConversationMessages[index + 1];
    return !next || next.seq - message.seq > insertions.length;
  });

  if (canUseGaps) {
    for (const [sourceMessageId, insertions] of insertionsByMessageId) {
      const sourceIndex = existingConversationMessages.findIndex((message) => message.id === sourceMessageId);
      const source = existingConversationMessages[sourceIndex];
      if (!source) continue;
      const next = existingConversationMessages[sourceIndex + 1];
      const step = next ? Math.floor((next.seq - source.seq) / (insertions.length + 1)) : MESSAGE_SEQ_STEP;
      insertions.forEach((insertion, index) => {
        insertion.message.seq = source.seq + step * (index + 1);
      });
    }
    return [...allMessages, ...backfilled.map((item) => item.message)];
  }

  const orderedConversationMessages: MessageRecord[] = [];
  for (const message of existingConversationMessages) {
    orderedConversationMessages.push(message);
    const insertions = insertionsByMessageId.get(message.id) ?? [];
    orderedConversationMessages.push(...insertions.map((item) => item.message));
  }

  const seqByMessageId = new Map<string, number>();
  orderedConversationMessages.forEach((message, index) => {
    seqByMessageId.set(message.id, (index + 1) * MESSAGE_SEQ_STEP);
  });

  return allMessages
    .filter((message) => message.conversationId !== conversationId)
    .concat(orderedConversationMessages.map((message) => ({ ...message, seq: seqByMessageId.get(message.id) ?? message.seq })));
}

function groupBackfilledMessages(backfilled: readonly BackfilledMessage[]): Map<string, BackfilledMessage[]> {
  const grouped = new Map<string, BackfilledMessage[]>();
  for (const item of backfilled) {
    const list = grouped.get(item.sourceMessageId) ?? [];
    list.push(item);
    grouped.set(item.sourceMessageId, list);
  }
  return grouped;
}

function addBackfilledRunLinks(
  state: ClientState,
  pending: readonly PendingToolCall[],
  backfilled: readonly BackfilledMessage[],
  now: number
): void {
  if (state.toolCallRunLinks.length === 0) return;
  const existing = new Set(state.messageRunLinks.map((link) => `${link.messageId}:${link.runId}:${link.role}`));
  const ids = new Set(state.messageRunLinks.map((link) => link.id));

  pending.forEach((call, index) => {
    const toolCallId = call.toolCall?.id;
    if (!toolCallId) return;
    const responseMessage = backfilled[index]?.message;
    if (!responseMessage) return;

    for (const link of state.toolCallRunLinks.filter((candidate) => candidate.toolCallId === toolCallId)) {
      const key = `${responseMessage.id}:${link.runId}:tool_response`;
      if (existing.has(key)) continue;
      existing.add(key);
      state.messageRunLinks.push({
        id: uniqueId(ids, `mrl-${responseMessage.id}-${link.runId}-${now}`),
        messageId: responseMessage.id,
        runId: link.runId,
        role: 'tool_response'
      });
    }
  });
}

function compareMessages(left: MessageRecord, right: MessageRecord): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function primaryIdentity(call: PendingToolCall): string | undefined {
  return call.ids[0] ?? normalizeId(call.part.id);
}

function normalizeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function safeId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 80) || 'tool-response';
}

function uniqueId(existing: Set<string>, base: string): string {
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  existing.add(candidate);
  return candidate;
}
