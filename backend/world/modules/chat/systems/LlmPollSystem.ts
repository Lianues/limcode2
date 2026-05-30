import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { LlmEventType } from '../../llm/events';
import { ToolCall } from '../../tools/components';
import { spawnToolCall, ToolCallBundle } from '../../tools/bundles';
import { LlmRequest, Message, Streaming, type MessageData } from '../components';
import { isFunctionCallPart, isVisibleTextPart, type ContentPart } from '../../../../../shared/protocol';

interface PendingThoughtPart {
  text: string;
  thoughtDurationMs: number;
  thoughtSignature?: string;
  thoughtSignatures?: Record<string, string | undefined>;
}

interface PendingRequestUpdate {
  thoughts: PendingThoughtPart[];
  delta: string;
  calls: Array<{ id?: string; name: string; argsJson: string; thoughtSignature?: string }>;
  done: boolean;
  createdAt?: number;
  streamOutputDurationMs?: number;
  error?: string;
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
  worker: { modulePath: '../world/modules/chat/systems/LlmPollSystem', exportName: 'LlmPollSystem' },
  access: {
    queries: [LlmRequestsByIdQuery, ModelMessagesQuery, ToolCallLookupQuery],
    writes: { components: [Streaming] },
    events: { read: [LlmEventType.Thought, LlmEventType.Delta, LlmEventType.ToolCall, LlmEventType.Done, LlmEventType.Error] },
    bundles: [ToolCallBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const updates = new Map<string, PendingRequestUpdate>();

    for (const payload of readEvents(ctx, LlmEventType.Thought)) {
      updateFor(updates, payload.requestId).thoughts.push(payload);
    }

    for (const payload of readEvents(ctx, LlmEventType.Delta)) {
      updateFor(updates, payload.requestId).delta += payload.text;
    }

    for (const payload of readEvents(ctx, LlmEventType.ToolCall)) {
      updateFor(updates, payload.requestId).calls.push(...payload.calls);
    }

    for (const payload of readEvents(ctx, LlmEventType.Error)) {
      const update = updateFor(updates, payload.requestId);
      update.error = payload.message;
      update.createdAt = payload.createdAt;
      update.streamOutputDurationMs = payload.streamOutputDurationMs;
      update.done = true;
    }

    for (const payload of readEvents(ctx, LlmEventType.Done)) {
      const update = updateFor(updates, payload.requestId);
      update.createdAt = payload.createdAt;
      update.streamOutputDurationMs = payload.streamOutputDurationMs;
      update.done = true;
    }

    for (const [requestId, update] of updates) {
      applyRequestUpdate(world, cmd, requestId, update);
    }
  }
});

function updateFor(updates: Map<string, PendingRequestUpdate>, requestId: string): PendingRequestUpdate {
  let update = updates.get(requestId);
  if (!update) {
    update = { thoughts: [], delta: '', calls: [], done: false };
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

  const modelMessage = requestData.modelMessageEntity;
  const current = world.get(modelMessage, Message);
  if (!current) return;

  let next = current;
  for (const thought of update.thoughts) next = appendThoughtPart(next, thought);
  if (update.delta) next = appendTextToMessage(next, update.delta);

  const existingFunctionCallIds = new Set(
    next.content.parts
      .filter(isFunctionCallPart)
      .map((part) => part.id)
      .filter((id): id is string => !!id)
  );
  const spawnedOrSeenCallIds = new Set<string>();

  for (const rawCall of update.calls) {
    const toolCallId = normalizeToolCallId(requestId, rawCall, spawnedOrSeenCallIds.size);
    if (spawnedOrSeenCallIds.has(toolCallId)) continue;
    spawnedOrSeenCallIds.add(toolCallId);

    if (!existingFunctionCallIds.has(toolCallId)) {
      next = appendFunctionCallPart(next, { id: toolCallId, name: rawCall.name, argsJson: rawCall.argsJson, thoughtSignature: rawCall.thoughtSignature });
      existingFunctionCallIds.add(toolCallId);
    }

    if (!toolCallExists(world, toolCallId)) {
      spawnToolCall(cmd, { modelMessage, id: toolCallId, name: rawCall.name, argsJson: rawCall.argsJson });
    }
  }

  if (update.error) {
    next = appendTextToMessage(next, `\n[error] ${update.error}`);
    next = withLlmTiming({ ...next, status: 'error' }, update);
  } else if (update.done) {
    next = withLlmTiming({ ...next, status: 'complete' }, update);
  } else if (update.createdAt !== undefined || update.streamOutputDurationMs !== undefined) {
    next = withLlmTiming(next, update);
  }

  if (next !== current) {
    cmd.add(modelMessage, Message, next);
  }

  if (update.done) {
    cmd.remove(modelMessage, Streaming);
    cmd.despawn(request);
  }
}

function withLlmTiming(message: MessageData, update: PendingRequestUpdate): MessageData {
  return {
    ...message,
    ...(update.createdAt !== undefined ? { createdAt: update.createdAt } : {}),
    ...(update.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: update.streamOutputDurationMs } : {})
  };
}

function appendThoughtPart(message: MessageData, thought: PendingThoughtPart): MessageData {
  const part: ContentPart = {
    text: thought.text,
    thought: true,
    thoughtDurationMs: thought.thoughtDurationMs,
    ...(thought.thoughtSignature ? { thoughtSignature: thought.thoughtSignature } : {}),
    ...(thought.thoughtSignatures ? { thoughtSignatures: thought.thoughtSignatures } : {})
  };
  return { ...message, content: { ...message.content, parts: [...message.content.parts, part] } };
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
