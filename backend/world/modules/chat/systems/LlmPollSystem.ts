import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import {
  LlmEventType,
  type LlmDeltaPayload,
  type LlmDonePayload,
  type LlmErrorPayload,
  type LlmThoughtDeltaPayload,
  type LlmThoughtDonePayload,
  type LlmToolCallPayload
} from '../../llm/events';
import { ToolCall } from '../../tools/components';
import { spawnToolCall, ToolCallBundle } from '../../tools/bundles';
import { AgentRun } from '../../agentRun/components';
import { spawnToolCallRunLink } from '../../agentRun/bundles';
import { LlmRequest, Message, Streaming, type MessageData } from '../components';
import { isFunctionCallPart, isTextPart, isVisibleTextPart, type ContentPart } from '../../../../../shared/protocol';

type PendingOperation =
  | { kind: 'thoughtDelta'; payload: LlmThoughtDeltaPayload }
  | { kind: 'thoughtDone'; payload: LlmThoughtDonePayload }
  | { kind: 'delta'; payload: LlmDeltaPayload }
  | { kind: 'toolCall'; payload: LlmToolCallPayload }
  | { kind: 'done'; payload: LlmDonePayload }
  | { kind: 'error'; payload: LlmErrorPayload };

interface PendingRequestUpdate {
  operations: PendingOperation[];
}

const LlmRequestsByIdQuery = defineQuery({
  name: 'LlmRequestsById',
  all: [LlmRequest],
  read: [LlmRequest],
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
    queries: [LlmRequestsByIdQuery, ModelMessagesQuery, ToolCallLookupQuery],
    writes: { components: [Streaming, AgentRun] },
    events: { read: [LlmEventType.ThoughtDelta, LlmEventType.ThoughtDone, LlmEventType.Delta, LlmEventType.ToolCall, LlmEventType.Done, LlmEventType.Error] },
    bundles: [ToolCallBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const updates = new Map<string, PendingRequestUpdate>();

    for (const event of ctx.events) {
      switch (event.type) {
        case LlmEventType.ThoughtDelta:
          pushOperation(updates, { kind: 'thoughtDelta', payload: event.payload as LlmThoughtDeltaPayload });
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
      }
    }

    for (const [requestId, update] of updates) {
      applyRequestUpdate(world, cmd, requestId, update);
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

function applyRequestUpdate(world: WorldReader, cmd: CommandSink, requestId: string, update: PendingRequestUpdate): void {
  const request = requestOf(world, requestId);
  if (request === undefined) return;

  const requestData = world.get(request, LlmRequest);
  if (!requestData) return;

  const modelMessage = requestData.modelMessage;
  const current = world.get(modelMessage, Message);
  if (!current) return;

  if (isRunCancelledOrStale(world, requestData.run)) {
    if (hasTerminalOperation(update)) cleanupCancelledRequest(cmd, request, modelMessage, current);
    return;
  }

  let next = current;
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

  for (const operation of update.operations) {
    switch (operation.kind) {
      case 'thoughtDelta':
        next = appendThoughtDelta(next, operation.payload);
        break;
      case 'thoughtDone':
        next = finishThoughtPart(next, operation.payload);
        break;
      case 'delta':
        next = appendTextToMessage(next, operation.payload.text);
        break;
      case 'toolCall':
        sawToolCall = true;
        for (const rawCall of operation.payload.calls) {
          const toolCallId = normalizeToolCallId(requestId, rawCall, spawnedOrSeenCallIds.size);
          if (spawnedOrSeenCallIds.has(toolCallId)) continue;
          spawnedOrSeenCallIds.add(toolCallId);

          if (!existingFunctionCallIds.has(toolCallId)) {
            next = appendFunctionCallPart(next, { id: toolCallId, name: rawCall.name, argsJson: rawCall.argsJson, thoughtSignature: rawCall.thoughtSignature });
            existingFunctionCallIds.add(toolCallId);
          }

          if (!toolCallExists(world, toolCallId)) {
            const toolCall = spawnToolCall(cmd, { modelMessage, id: toolCallId, name: rawCall.name, argsJson: rawCall.argsJson });
            spawnToolCallRunLink(cmd, { toolCall, run: requestData.run });
          }
        }
        break;
      case 'error':
        errorMessage = operation.payload.message;
        next = appendTextToMessage(next, `\n[error] ${operation.payload.message}`);
        next = withLlmTiming({ ...next, status: 'error' }, operation.payload);
        shouldFinish = true;
        break;
      case 'done':
        next = withLlmTiming({ ...next, status: 'complete' }, operation.payload);
        shouldFinish = true;
        break;
    }
  }

  if (next !== current) {
    cmd.add(modelMessage, Message, next);
  }

  if (shouldFinish) {
    cmd.remove(modelMessage, Streaming);
    cmd.despawn(request);
    const run = world.get(requestData.run, AgentRun);
    if (run) {
      const now = Date.now();
      cmd.add(requestData.run, AgentRun, {
        ...run,
        status: errorMessage ? 'failed' : sawToolCall ? 'waiting_tool' : 'delivering',
        updatedAt: now,
        ...(errorMessage ? { error: errorMessage } : {})
      });
    }
  }
}

function withLlmTiming(message: MessageData, update: LlmDonePayload | LlmErrorPayload): MessageData {
  return {
    ...message,
    ...(update.createdAt !== undefined ? { createdAt: update.createdAt } : {}),
    ...(update.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: update.streamOutputDurationMs } : {}),
    ...('usageMetadata' in update && update.usageMetadata !== undefined ? { usageMetadata: update.usageMetadata } : {})
  };
}

function appendThoughtDelta(message: MessageData, thought: LlmThoughtDeltaPayload): MessageData {
  const parts = [...message.content.parts];
  const last = parts[parts.length - 1];
  if (last && isTextPart(last) && last.thought === true && last.thoughtDurationMs === undefined) {
    parts[parts.length - 1] = {
      ...last,
      text: last.text + thought.text,
      ...(thought.thoughtSignature ? { thoughtSignature: thought.thoughtSignature } : {})
    };
    return { ...message, content: { ...message.content, parts } };
  }

  const part: ContentPart = {
    text: thought.text,
    thought: true,
    ...(thought.thoughtSignature ? { thoughtSignature: thought.thoughtSignature } : {})
  };
  return { ...message, content: { ...message.content, parts: [...message.content.parts, part] } };
}

function finishThoughtPart(message: MessageData, thought: LlmThoughtDonePayload): MessageData {
  const parts = [...message.content.parts];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part || !isTextPart(part) || part.thought !== true || part.thoughtDurationMs !== undefined) continue;
    parts[index] = {
      ...part,
      thoughtDurationMs: thought.thoughtDurationMs,
      ...(thought.thoughtSignature ? { thoughtSignature: thought.thoughtSignature } : {})
    };
    return { ...message, content: { ...message.content, parts } };
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

function appendTextToMessage(message: MessageData, delta: string): MessageData {
  if (!delta) return message;
  const parts = [...message.content.parts];
  const last = parts[parts.length - 1];
  if (last && isVisibleTextPart(last)) {
    parts[parts.length - 1] = { ...last, text: last.text + delta };
  } else {
    parts.push({ text: delta });
  }
  return { ...message, content: { ...message.content, parts } };
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
  return data?.status === 'cancelled' || data?.status === 'stale';
}

function hasTerminalOperation(update: PendingRequestUpdate): boolean {
  return update.operations.some((operation) => operation.kind === 'done' || operation.kind === 'error');
}

function cleanupCancelledRequest(cmd: CommandSink, request: Entity, modelMessage: Entity, current: MessageData): void {
  cmd.add(modelMessage, Message, { ...current, status: 'error' });
  cmd.remove(modelMessage, Streaming);
  cmd.despawn(request);
}
