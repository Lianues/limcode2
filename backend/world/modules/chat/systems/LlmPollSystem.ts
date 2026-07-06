import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import {
  LlmEventType,
  type LlmDeltaPayload,
  type LlmDonePayload,
  type LlmErrorPayload,
  type LlmStartedPayload,
  type LlmThoughtDeltaPayload,
  type LlmThoughtProgressPayload,
  type LlmThoughtDonePayload,
  type LlmToolCallPayload,
  type LlmRetryPayload
} from '../../llm/events';
import { LlmInvocation, type LlmInvocationData } from '../../llm/components';
import { compressionThresholdTokens, observedUsageTokenCount } from '../../llm/usage';
import { ToolCall, ToolCallEvent } from '../../tools/components';
import { spawnToolCall, ToolCallBundle } from '../../tools/bundles';
import { AgentRun, ToolCallRunLink } from '../../agentRun/components';
import { spawnToolCallRunLink } from '../../agentRun/bundles';
import { CompressionBlock } from '../../compression/components';
import { CompressionEventType } from '../../compression/events';
import { LlmRequest, Message, Streaming, Conversation, PartOf, type LlmRequestData, type MessageData } from '../components';
import {
  conversationClientStateStreamId,
  createMessageId,
  isFunctionCallPart,
  isFunctionResponsePart,
  isProviderContextPart,
  isTextPart,
  isVisibleTextPart,
  type ClientPatchOp,
  type ContentPart,
  type LlmTransientNoticeKind,
  type LlmUsageMetadataRecord
} from '../../../../../shared/protocol';
import { CheckpointEventType } from '../../checkpoint/events';
import { ClientSyncFastPatchStateKey, type ClientSyncFastPatchBatch } from '../../../clientSync/resources';

type PendingOperation =
  | { kind: 'started'; payload: LlmStartedPayload }
  | { kind: 'thoughtDelta'; payload: LlmThoughtDeltaPayload }
  | { kind: 'thoughtProgress'; payload: LlmThoughtProgressPayload }
  | { kind: 'thoughtDone'; payload: LlmThoughtDonePayload }
  | { kind: 'delta'; payload: LlmDeltaPayload }
  | { kind: 'toolCall'; payload: LlmToolCallPayload }
  | { kind: 'done'; payload: LlmDonePayload }
  | { kind: 'retryScheduled'; payload: LlmRetryPayload }
  | { kind: 'retryStarted'; payload: LlmRetryPayload }
  | { kind: 'retryCancelled'; payload: LlmRetryPayload }
  | { kind: 'retryRecovered'; payload: LlmRetryPayload }
  | { kind: 'error'; payload: LlmErrorPayload };

interface PendingRequestUpdate {
  operations: PendingOperation[];
}

const AUTO_COMPRESSION_DEBUG_PREFIX = '[LimCode][AutoCompressionDebug]';

const LlmInvocationsByIdQuery = defineQuery({
  name: 'LlmInvocationsById',
  all: [LlmInvocation],
  read: [LlmInvocation],
  write: [LlmInvocation],
  mutationMode: 'update',
  role: 'lookup'
});

const LlmRequestsByIdQuery = defineQuery({
  name: 'LlmRequestsById',
  all: [LlmRequest],
  read: [LlmRequest, Conversation],
  remove: [LlmRequest],
  mutationMode: 'consume',
  role: 'lookup'
});

const ModelMessagesQuery = defineQuery({
  name: 'ModelMessages',
  all: [Message],
  read: [Message],
  write: [Message],
  mutationMode: 'update',
  role: 'lookup'
});

const ToolCallLookupQuery = defineQuery({
  name: 'ToolCallLookup',
  all: [ToolCall],
  read: [ToolCall],
  role: 'lookup'
});

export const LlmPollSystem = defineSystem({
  name: 'LlmPollSystem',
  access: {
    queries: [LlmInvocationsByIdQuery, LlmRequestsByIdQuery, ModelMessagesQuery, ToolCallLookupQuery],
    reads: { components: [PartOf, CompressionBlock, ToolCallEvent, ToolCallRunLink] },
    writes: { components: [Streaming, AgentRun, ToolCall, ToolCallEvent, ToolCallRunLink] },
    resources: { read: [ClientSyncFastPatchStateKey], write: [ClientSyncFastPatchStateKey], mutationMode: 'update' },
    events: { read: [LlmEventType.Started, LlmEventType.ThoughtDelta, LlmEventType.ThoughtProgress, LlmEventType.ThoughtDone, LlmEventType.Delta, LlmEventType.ToolCall, LlmEventType.Done, LlmEventType.Error, LlmEventType.RetryScheduled, LlmEventType.RetryStarted, LlmEventType.RetryCancelled, LlmEventType.RetryRecovered], emit: [CheckpointEventType.Requested, CompressionEventType.Create] },
    effects: { emit: ['client.transientNotice'] },
    bundles: [ToolCallBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const updates = new Map<string, PendingRequestUpdate>();
    const fastPatchBatches: ClientSyncFastPatchBatch[] = [];
    let requireFullSync = false;

    for (const event of ctx.events) {
      switch (event.type) {
        case LlmEventType.Started:
          pushOperation(updates, { kind: 'started', payload: event.payload as LlmStartedPayload });
          break;
        case LlmEventType.ThoughtDelta:
          pushOperation(updates, { kind: 'thoughtDelta', payload: event.payload as LlmThoughtDeltaPayload });
          break;
        case LlmEventType.ThoughtProgress:
          pushOperation(updates, { kind: 'thoughtProgress', payload: event.payload as LlmThoughtProgressPayload });
          break;
        case LlmEventType.ThoughtDone:
          pushOperation(updates, { kind: 'thoughtDone', payload: event.payload as LlmThoughtDonePayload });
          break;
        case LlmEventType.Delta:
          pushOperation(updates, { kind: 'delta', payload: event.payload as LlmDeltaPayload });
          break;
        case LlmEventType.ToolCall:
          pushOperation(updates, { kind: 'toolCall', payload: event.payload as LlmToolCallPayload });
          break;
        case LlmEventType.Done:
          pushOperation(updates, { kind: 'done', payload: event.payload as LlmDonePayload });
          break;
        case LlmEventType.Error:
          pushOperation(updates, { kind: 'error', payload: event.payload as LlmErrorPayload });
          break;
        case LlmEventType.RetryScheduled:
          pushOperation(updates, { kind: 'retryScheduled', payload: event.payload as LlmRetryPayload });
          break;
        case LlmEventType.RetryStarted:
          pushOperation(updates, { kind: 'retryStarted', payload: event.payload as LlmRetryPayload });
          break;
        case LlmEventType.RetryCancelled:
          pushOperation(updates, { kind: 'retryCancelled', payload: event.payload as LlmRetryPayload });
          break;
        case LlmEventType.RetryRecovered:
          pushOperation(updates, { kind: 'retryRecovered', payload: event.payload as LlmRetryPayload });
          break;
      }
    }

    for (const [requestId, update] of updates) {
      const result = applyRequestUpdate(world, cmd, requestId, update);
      fastPatchBatches.push(...result.fastPatchBatches);
      requireFullSync = result.requireFullSync || requireFullSync;
    }

    const hasActiveLlmRequests = world.query(LlmRequest).length > 0;
    const current = world.getResource(ClientSyncFastPatchStateKey);
    const nextRequireFullSync = current.requireFullSync || requireFullSync;
    const nextDeferFullSync = hasActiveLlmRequests && (current.deferFullSync || fastPatchBatches.length > 0 || nextRequireFullSync);
    if (fastPatchBatches.length > 0 || current.deferFullSync !== nextDeferFullSync || current.requireFullSync !== nextRequireFullSync) {
      cmd.setResource(ClientSyncFastPatchStateKey, {
        patches: [...current.patches, ...fastPatchBatches],
        deferFullSync: nextDeferFullSync,
        requireFullSync: nextRequireFullSync
      });
    }
  }
});

function pushOperation(updates: Map<string, PendingRequestUpdate>, operation: PendingOperation): void {
  updateFor(updates, operation.payload.requestId).operations.push(operation);
}

function updateFor(updates: Map<string, PendingRequestUpdate>, requestId: string): PendingRequestUpdate {
  let update = updates.get(requestId);
  if (!update) {
    update = { operations: [] };
    updates.set(requestId, update);
  }
  return update;
}

function requestOf(world: WorldReader, requestId: string): Entity | undefined {
  return world.query(LlmRequest).find((request) => world.get(request, LlmRequest)?.id === requestId);
}

function maybeEnqueueAutoCompression(
  world: WorldReader,
  cmd: CommandSink,
  input: { conversation: Entity; endMessage: MessageData; invocation?: Entity; usageMetadata?: LlmUsageMetadataRecord; stage: 'llm_response_after' }
): void {
  if (!input.usageMetadata || input.invocation === undefined) return;
  const conversation = world.get(input.conversation, Conversation);
  const invocation = world.get(input.invocation, LlmInvocation);
  const settings = invocation?.settings;
  const trigger = settings?.compressionTrigger;
  if (!settings || !trigger || trigger.mode !== 'token_threshold' || settings.compressionMethodKind === 'disabled') return;

  const observedTokens = observedUsageTokenCount(input.usageMetadata);
  const thresholdTokens = compressionThresholdTokens(settings);
  debugAutoCompression('llm.done.check', {
    stage: input.stage,
    conversationId: conversation?.id,
    endMessage: describeMessageData(input.endMessage),
    invocationId: invocation?.id,
    methodKind: settings.compressionMethodKind,
    compressionConfigId: settings.compressionConfigId,
    observedTokens,
    thresholdTokens
  });
  if (observedTokens === undefined || thresholdTokens === undefined || observedTokens < thresholdTokens) {
    debugAutoCompression('llm.done.skipBelowThreshold', { conversationId: conversation?.id, observedTokens, thresholdTokens });
    return;
  }

  if (hasCompressionBlockForAnchor(world, input.conversation, input.endMessage.id)) {
    debugAutoCompression('llm.done.skipDuplicateAnchor', {
      conversationId: conversation?.id,
      endMessage: describeMessageData(input.endMessage)
    });
    return;
  }

  if (!conversation) return;
  debugAutoCompression('llm.done.enqueue', {
    conversationId: conversation.id,
    endMessage: describeMessageData(input.endMessage),
    methodKind: settings.compressionMethodKind,
    compressionConfigId: settings.compressionConfigId
  });
  cmd.enqueue({
    type: CompressionEventType.Create,
    payload: {
      conversationId: conversation.id,
      endMessageId: input.endMessage.id,
      ...(settings.compressionConfigId ? { methodConfigId: settings.compressionConfigId } : {}),
      ...(settings.compressionMethodKind ? { methodKind: settings.compressionMethodKind } : {}),
      trigger: 'auto' as const
    }
  });
}

function hasCompressionBlockForAnchor(world: WorldReader, conversation: Entity, anchorMessageId: string): boolean {
  return world.query(CompressionBlock).some((entity) => {
    const block = world.get(entity, CompressionBlock);
    return block?.conversation === conversation
      && block.anchorMessageId === anchorMessageId
      && (block.status === 'running' || block.status === 'pending' || block.status === 'complete');
  });
}

function debugAutoCompression(stage: string, payload: Record<string, unknown>): void {
  void stage;
  void payload;
}

function describeMessageEntity(world: WorldReader, entity: Entity): Record<string, unknown> | undefined {
  const message = world.get(entity, Message);
  return message ? describeMessageData(message) : undefined;
}

function describeMessageData(message: MessageData): Record<string, unknown> {
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    status: message.status,
    partKinds: message.content.parts.map(describePartKind),
    visibleTextLength: message.content.parts
      .filter(isVisibleTextPart)
      .reduce((total, part) => total + ('text' in part ? part.text.length : 0), 0)
  };
}

function describePartKind(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? 'thoughtText' : 'text';
  if (isFunctionCallPart(part)) return `functionCall:${part.functionCall.name}`;
  if (isFunctionResponsePart(part)) return `functionResponse:${part.functionResponse.name}`;
  if (isProviderContextPart(part)) return `providerContext:${part.providerContext.itemType ?? part.providerContext.format}`;
  return Object.keys(part)[0] ?? 'unknown';
}


interface ApplyRequestUpdateResult {
  fastPatchBatches: ClientSyncFastPatchBatch[];
  requireFullSync: boolean;
}

function applyRequestUpdate(world: WorldReader, cmd: CommandSink, requestId: string, update: PendingRequestUpdate): ApplyRequestUpdateResult {
  const request = requestOf(world, requestId);
  if (request === undefined) return emptyApplyResult();

  const requestData = world.get(request, LlmRequest);
  if (!requestData) return emptyApplyResult();

  const modelMessage = requestData.modelMessage;
  const current = world.get(modelMessage, Message);
  if (!current) return emptyApplyResult();

  if (isRunCancelledOrStale(world, requestData.run)) {
    if (hasTerminalOperation(update)) cleanupCancelledRequest(world, cmd, request, modelMessage, current, requestData.invocation);
    return { fastPatchBatches: [], requireFullSync: hasTerminalOperation(update) };
  }

  let next = current;
  let nextInvocation = requestData.invocation !== undefined ? world.get(requestData.invocation, LlmInvocation) : undefined;
  const existingFunctionCallIds = new Set(
    next.content.parts
      .filter(isFunctionCallPart)
      .map((part) => part.id)
      .filter((id): id is string => !!id)
  );
  const spawnedOrSeenCallIds = new Set<string>();
  let shouldFinish = false;
  let sawToolCall = false;
  let errorMessage: string | undefined;
  let usageMetadata: MessageData['usageMetadata'] | undefined;
  const fastPatches: ClientPatchOp[] = [];
  let fastPatchSafe = true;

  for (const operation of update.operations) {
    switch (operation.kind) {
      case 'started':
        nextInvocation = markInvocationStreaming(nextInvocation, operation.payload.startedAt);
        fastPatchSafe = false;
        break;
      case 'retryScheduled':
        emitTransientNotice(world, cmd, requestId, requestData, current, 'retryScheduled', operation.payload);
        break;
      case 'retryStarted':
        emitTransientNotice(world, cmd, requestId, requestData, current, 'retryStarted', operation.payload);
        next = resetMessageForRetry(next);
        existingFunctionCallIds.clear();
        cleanupToolCallsForMessage(world, cmd, modelMessage);
        fastPatchSafe = false;
        break;
      case 'retryCancelled':
        emitTransientNotice(world, cmd, requestId, requestData, current, 'retryCancelled', operation.payload);
        break;
      case 'retryRecovered':
        emitTransientNotice(world, cmd, requestId, requestData, current, 'retryRecovered', operation.payload);
        break;
      case 'thoughtDelta': {
        const updateResult = appendThoughtDeltaWithPatch(next, operation.payload);
        next = updateResult.message;
        if (updateResult.patches) fastPatches.push(...updateResult.patches);
        else if (next !== current) fastPatchSafe = false;
        break;
      }
      case 'thoughtProgress': {
        const updateResult = updateThoughtProgressWithPatch(next, operation.payload);
        next = updateResult.message;
        if (updateResult.patch) fastPatches.push(updateResult.patch);
        else if (next !== current) fastPatchSafe = false;
        break;
      }
      case 'thoughtDone':
        next = finishThoughtPart(next, operation.payload);
        fastPatchSafe = false;
        break;
      case 'delta': {
        const updateResult = appendTextToMessageWithPatch(next, operation.payload.text);
        next = updateResult.message;
        if (updateResult.patch) fastPatches.push(updateResult.patch);
        else if (next !== current) fastPatchSafe = false;
        break;
      }
      case 'toolCall':
        sawToolCall = true;
        for (const rawCall of operation.payload.calls) {
          const toolCallId = normalizeToolCallId(requestId, rawCall, spawnedOrSeenCallIds.size);
          if (spawnedOrSeenCallIds.has(toolCallId)) continue;
          spawnedOrSeenCallIds.add(toolCallId);

          if (!existingFunctionCallIds.has(toolCallId)) {
            next = appendFunctionCallPart(next, { id: toolCallId, name: rawCall.name, argsJson: rawCall.argsJson, thoughtSignature: rawCall.thoughtSignature });
            existingFunctionCallIds.add(toolCallId);
            fastPatchSafe = false;
          }

          if (!toolCallExists(world, toolCallId)) {
            const toolCall = spawnToolCall(cmd, { modelMessage, id: toolCallId, name: rawCall.name, argsJson: rawCall.argsJson });
            spawnToolCallRunLink(cmd, { toolCall, run: requestData.run });
          }
        }
        break;
      case 'error':
        errorMessage = operation.payload.message;
        emitTransientNotice(world, cmd, requestId, requestData, next, 'error', operation.payload);
        next = withLlmTiming({ ...next, status: 'error' }, operation.payload, nextInvocation?.startedAt);
        nextInvocation = markInvocationError(nextInvocation, operation.payload.message, operation.payload);
        shouldFinish = true;
        fastPatchSafe = false;
        break;
      case 'done':
        usageMetadata = operation.payload.usageMetadata;
        next = withLlmTiming({ ...next, status: 'complete' }, operation.payload, nextInvocation?.startedAt);
        nextInvocation = markInvocationComplete(nextInvocation, operation.payload);
        shouldFinish = true;
        fastPatchSafe = false;
        break;
    }
  }

  if (next !== current) {
    cmd.add(modelMessage, Message, next);
  }

  if (requestData.invocation !== undefined && nextInvocation !== undefined && nextInvocation !== world.get(requestData.invocation, LlmInvocation)) {
    cmd.add(requestData.invocation, LlmInvocation, nextInvocation);
  }

  const conversation = world.get(requestData.conversation, Conversation);
  const fastPatchBatches = fastPatchSafe && fastPatches.length > 0 && conversation
    ? [{ streamId: conversationClientStateStreamId(conversation.id), patches: fastPatches }]
    : [];

  if (shouldFinish) {
    cmd.remove(modelMessage, Streaming);
    cmd.despawn(request);
    const run = world.get(requestData.run, AgentRun);
    if (run) {
      const now = Date.now();
      const waitsForTool = sawToolCall || next.content.parts.some(isFunctionCallPart);
      const nextStatus = errorMessage ? 'failed' : waitsForTool ? 'waiting_tool' : 'delivering';
      if (!errorMessage && conversation) {
        cmd.enqueue({
          type: CheckpointEventType.Requested,
          payload: { conversationId: conversation.id, runId: run.id, floorMessageId: current.id, anchorPosition: 'after', trigger: 'llm_response_after' }
        });
        if (waitsForTool) {
          debugAutoCompression('llm.done.deferForToolResponses', {
            conversationId: conversation.id,
            modelMessage: describeMessageData(next)
          });
        } else {
          maybeEnqueueAutoCompression(world, cmd, { conversation: requestData.conversation, endMessage: next, invocation: requestData.invocation, usageMetadata, stage: 'llm_response_after' });
        }
      }
      cmd.add(requestData.run, AgentRun, {
        ...run,
        status: nextStatus,
        updatedAt: now,
        ...(errorMessage ? { error: errorMessage, completedAt: now, endReason: 'failed' as const, errorType: 'llm' as const } : {}),
        ...(usageMetadata ? { usageMetadata: mergeUsageMetadata(run.usageMetadata, usageMetadata) } : {})
      });
    }
  }

  return {
    fastPatchBatches,
    requireFullSync: !fastPatchSafe || shouldFinish
  };
}

function emptyApplyResult(): ApplyRequestUpdateResult {
  return { fastPatchBatches: [], requireFullSync: false };
}

function emitTransientNotice(
  world: WorldReader,
  cmd: CommandSink,
  requestId: string,
  requestData: LlmRequestData,
  message: MessageData,
  kind: LlmTransientNoticeKind,
  payload: LlmRetryPayload | LlmErrorPayload
): void {
  const conversation = world.get(requestData.conversation, Conversation);
  if (!conversation) return;
  const run = world.get(requestData.run, AgentRun);
  const invocation = requestData.invocation !== undefined ? world.get(requestData.invocation, LlmInvocation) : undefined;
  cmd.effect({
    kind: 'client.transientNotice',
    streamId: conversationClientStateStreamId(conversation.id),
    payload: {
      id: createMessageId(),
      kind,
      conversationId: conversation.id,
      messageId: message.id,
      requestId,
      ...(run?.id ? { runId: run.id } : {}),
      ...(invocation?.id ? { invocationId: invocation.id } : {}),
      message: payload.message,
      ...(payload.rawError ? { rawError: payload.rawError } : {}),
      ...(payload.retryAttempt !== undefined ? { retryAttempt: payload.retryAttempt } : {}),
      ...(payload.retryMaxAttempts !== undefined ? { retryMaxAttempts: payload.retryMaxAttempts } : {}),
      ...('retryDelayMs' in payload && payload.retryDelayMs !== undefined ? { retryDelayMs: payload.retryDelayMs } : {}),
      createdAt: payload.createdAt ?? Date.now()
    }
  });
}

function resetMessageForRetry(message: MessageData): MessageData {
  const { usageMetadata: _usageMetadata, streamOutputDurationMs: _streamOutputDurationMs, requestStartedAt: _requestStartedAt, stopReason: _stopReason, ...rest } = message;
  void _usageMetadata;
  void _streamOutputDurationMs;
  void _requestStartedAt;
  void _stopReason;
  return {
    ...rest,
    status: 'streaming',
    content: { ...message.content, parts: [] }
  };
}

function cleanupToolCallsForMessage(world: WorldReader, cmd: CommandSink, modelMessage: Entity): void {
  const toolCalls = new Set<Entity>();
  for (const entity of world.query(ToolCall, PartOf)) {
    const partOf = world.get(entity, PartOf);
    if (partOf?.parent === modelMessage) toolCalls.add(entity);
  }
  if (toolCalls.size === 0) return;

  for (const entity of world.query(ToolCallEvent, PartOf)) {
    const partOf = world.get(entity, PartOf);
    if (partOf && toolCalls.has(partOf.parent)) cmd.despawn(entity);
  }
  for (const entity of world.query(ToolCallRunLink)) {
    const link = world.get(entity, ToolCallRunLink);
    if (link && toolCalls.has(link.toolCall)) cmd.despawn(entity);
  }
  for (const entity of toolCalls) cmd.despawn(entity);
}


function markInvocationStreaming(invocation: LlmInvocationData | undefined, startedAt = Date.now()): LlmInvocationData | undefined {
  if (!invocation) return undefined;
  if (invocation.status === 'streaming' && invocation.startedAt !== undefined) return invocation;
  return { ...invocation, status: 'streaming', startedAt };
}

function markInvocationComplete(invocation: LlmInvocationData | undefined, update: LlmDonePayload): LlmInvocationData | undefined {
  if (!invocation) return undefined;
  const completedAt = Date.now();
  return {
    ...invocation,
    status: 'complete',
    completedAt,
    ...(update.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: update.streamOutputDurationMs } : {}),
    ...(update.usageMetadata !== undefined ? { usageMetadata: update.usageMetadata } : {})
  };
}

function markInvocationError(invocation: LlmInvocationData | undefined, message: string, update: LlmErrorPayload): LlmInvocationData | undefined {
  if (!invocation) return undefined;
  const completedAt = Date.now();
  return {
    ...invocation,
    status: 'error',
    completedAt,
    error: message,
    ...(update.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: update.streamOutputDurationMs } : {})
  };
}

function withLlmTiming(message: MessageData, update: LlmDonePayload | LlmErrorPayload, startedAt?: number): MessageData {
  return {
    ...message,
    ...(update.createdAt !== undefined ? { createdAt: update.createdAt } : {}),
    ...(update.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: update.streamOutputDurationMs } : {}),
    ...(startedAt !== undefined ? { requestStartedAt: startedAt } : {}),
    ...('usageMetadata' in update && update.usageMetadata !== undefined ? { usageMetadata: update.usageMetadata } : {})
  };
}

function appendThoughtDeltaWithPatch(message: MessageData, thought: LlmThoughtDeltaPayload): { message: MessageData; patches?: ClientPatchOp[] } {
  if (!thought.text) return { message };
  const parts = [...message.content.parts];
  const last = parts[parts.length - 1];
  if (last && isTextPart(last) && last.thought === true && last.thoughtDurationMs === undefined) {
    const index = parts.length - 1;
    parts[index] = {
      ...last,
      text: last.text + thought.text,
      ...(thought.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: thought.thoughtElapsedMs } : {}),
      ...(thought.thoughtSignature ? { thoughtSignature: thought.thoughtSignature } : {})
    };
    const next = { ...message, content: { ...message.content, parts } };
    if (thought.thoughtSignature && thought.thoughtSignature !== last.thoughtSignature) return { message: next };
    const patches: ClientPatchOp[] = [{ kind: 'message.partText.append', id: message.id, partIndex: index, delta: thought.text }];
    if (thought.thoughtElapsedMs !== undefined) patches.push({ kind: 'message.partThoughtElapsed.set', id: message.id, partIndex: index, elapsedMs: thought.thoughtElapsedMs });
    return { message: next, patches };
  }

  const part: ContentPart = {
    text: thought.text,
    thought: true,
    ...(thought.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: thought.thoughtElapsedMs } : {}),
    ...(thought.thoughtSignature ? { thoughtSignature: thought.thoughtSignature } : {})
  };
  return {
    message: { ...message, content: { ...message.content, parts: [...message.content.parts, part] } },
    patches: [{ kind: 'message.part.insert', id: message.id, index: message.content.parts.length, part }]
  };
}

function updateThoughtProgressWithPatch(message: MessageData, progress: LlmThoughtProgressPayload): { message: MessageData; patch?: ClientPatchOp } {
  const parts = [...message.content.parts];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part || !isTextPart(part) || part.thought !== true || part.thoughtDurationMs !== undefined) continue;
    parts[index] = {
      ...part,
      thoughtElapsedMs: progress.thoughtElapsedMs,
      ...(progress.thoughtSignature ? { thoughtSignature: progress.thoughtSignature } : {})
    };
    const next = { ...message, content: { ...message.content, parts } };
    if (progress.thoughtSignature && progress.thoughtSignature !== part.thoughtSignature) return { message: next };
    return { message: next, patch: { kind: 'message.partThoughtElapsed.set', id: message.id, partIndex: index, elapsedMs: progress.thoughtElapsedMs } };
  }
  return { message };
}

function finishThoughtPart(message: MessageData, thought: LlmThoughtDonePayload): MessageData {
  const parts = [...message.content.parts];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part || !isTextPart(part) || part.thought !== true || part.thoughtDurationMs !== undefined) continue;
    const { thoughtElapsedMs: _thoughtElapsedMs, ...rest } = part;
    void _thoughtElapsedMs;
    parts[index] = {
      ...rest,
      thoughtDurationMs: thought.thoughtDurationMs,
      ...(thought.thoughtSignature ? { thoughtSignature: thought.thoughtSignature } : {})
    };
    return { ...message, content: { ...message.content, parts } };
  }
  if (thought.thoughtSignature) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (!part || !isTextPart(part) || part.thought !== true || part.thoughtDurationMs === undefined || part.thoughtSignature) continue;
      parts[index] = {
        ...part,
        thoughtSignature: thought.thoughtSignature
      };
      return { ...message, content: { ...message.content, parts } };
    }
    return {
      ...message,
      content: {
        ...message.content,
        parts: [
          ...message.content.parts,
          {
            text: '',
            thought: true,
            thoughtDurationMs: thought.thoughtDurationMs,
            thoughtSignature: thought.thoughtSignature
          }
        ]
      }
    };
  }
  return message;
}

function appendFunctionCallPart(
  message: MessageData,
  call: { id: string; name: string; argsJson: string; thoughtSignature?: string }
): MessageData {
  let args: unknown = {};
  try {
    args = call.argsJson ? JSON.parse(call.argsJson) : {};
  } catch {
    args = call.argsJson;
  }

  const part: ContentPart = {
    id: call.id,
    functionCall: { name: call.name, args },
    ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
  };
  return { ...message, content: { ...message.content, parts: [...message.content.parts, part] } };
}

function appendTextToMessageWithPatch(message: MessageData, delta: string): { message: MessageData; patch?: ClientPatchOp } {
  if (!delta) return { message };
  const parts = [...message.content.parts];
  const last = parts[parts.length - 1];
  if (last && isVisibleTextPart(last)) {
    const index = parts.length - 1;
    parts[index] = { ...last, text: last.text + delta };
    return {
      message: { ...message, content: { ...message.content, parts } },
      patch: { kind: 'message.partText.append', id: message.id, partIndex: index, delta }
    };
  }

  const part: ContentPart = { text: delta };
  return {
    message: { ...message, content: { ...message.content, parts: [...message.content.parts, part] } },
    patch: { kind: 'message.part.insert', id: message.id, index: message.content.parts.length, part }
  };
}

function normalizeToolCallId(
  requestId: string,
  call: { id?: string; name: string; argsJson: string; thoughtSignature?: string },
  fallbackIndex: number
): string {
  return call.id || `tool-${requestId}-${call.name}-${shortHash(call.argsJson)}-${fallbackIndex}`;
}

function toolCallExists(world: WorldReader, toolCallId: string): boolean {
  return world.query(ToolCall).some((entity) => world.get(entity, ToolCall)?.id === toolCallId);
}

function shortHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function isRunCancelledOrStale(world: WorldReader, run: Entity): boolean {
  const data = world.get(run, AgentRun);
  return data?.status === 'cancelled' || data?.status === 'stale' || data?.status === 'paused';
}

function hasTerminalOperation(update: PendingRequestUpdate): boolean {
  return update.operations.some((operation) => operation.kind === 'done' || operation.kind === 'error');
}

function cleanupCancelledRequest(world: WorldReader, cmd: CommandSink, request: Entity, modelMessage: Entity, current: MessageData, invocation: Entity | undefined): void {
  cmd.add(modelMessage, Message, { ...current, status: 'error' });
  if (invocation !== undefined) {
    const currentInvocation = world.get(invocation, LlmInvocation);
    if (currentInvocation) cmd.add(invocation, LlmInvocation, { ...currentInvocation, status: 'cancelled', completedAt: Date.now() });
  }
  cmd.remove(modelMessage, Streaming);
  cmd.despawn(request);
}

function mergeUsageMetadata(previous: MessageData['usageMetadata'], next: MessageData['usageMetadata']): MessageData['usageMetadata'] {
  if (!previous) return next;
  if (!next) return previous;
  const merged: NonNullable<MessageData['usageMetadata']> = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    const current = merged[key];
    merged[key] = typeof current === 'number' && typeof value === 'number' ? current + value : value;
  }
  return merged;
}
