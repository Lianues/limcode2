import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { LlmEventType } from '../../llm/events';
import { ToolCall } from '../../tools/components';
import { spawnToolCall, ToolCallBundle } from '../../tools/bundles';
import { LlmRequest, Message, Streaming, type MessageData } from '../components';
import type { ContentPart } from '../../../../../shared/protocol';

interface PendingRequestUpdate {
  delta: string;
  calls: Array<{ id?: string; name: string; argsJson: string }>;
  done: boolean;
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
    events: { read: [LlmEventType.Delta, LlmEventType.ToolCall, LlmEventType.Done, LlmEventType.Error] },
    bundles: [ToolCallBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const updates = new Map<string, PendingRequestUpdate>();

    for (const payload of readEvents(ctx, LlmEventType.Delta)) {
      updateFor(updates, payload.requestId).delta += payload.text;
    }

    for (const payload of readEvents(ctx, LlmEventType.ToolCall)) {
      updateFor(updates, payload.requestId).calls.push(...payload.calls);
    }

    for (const payload of readEvents(ctx, LlmEventType.Error)) {
      const update = updateFor(updates, payload.requestId);
      update.error = payload.message;
      update.done = true;
    }

    for (const payload of readEvents(ctx, LlmEventType.Done)) {
      updateFor(updates, payload.requestId).done = true;
    }

    for (const [requestId, update] of updates) {
      applyRequestUpdate(world, cmd, requestId, update);
    }
  }
});

function updateFor(updates: Map<string, PendingRequestUpdate>, requestId: string): PendingRequestUpdate {
  let update = updates.get(requestId);
  if (!update) {
    update = { delta: '', calls: [], done: false };
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
  if (update.delta) next = appendTextToMessage(next, update.delta);

  const existingFunctionCallIds = new Set(
    next.content.parts
      .filter((part): part is Extract<ContentPart, { type: 'functionCall' }> => part.type === 'functionCall')
      .map((part) => part.id)
  );
  const spawnedOrSeenCallIds = new Set<string>();

  for (const rawCall of update.calls) {
    const toolCallId = normalizeToolCallId(requestId, rawCall, spawnedOrSeenCallIds.size);
    if (spawnedOrSeenCallIds.has(toolCallId)) continue;
    spawnedOrSeenCallIds.add(toolCallId);

    if (!existingFunctionCallIds.has(toolCallId)) {
      next = appendFunctionCallPart(next, { id: toolCallId, name: rawCall.name, argsJson: rawCall.argsJson });
      existingFunctionCallIds.add(toolCallId);
    }

    if (!toolCallExists(world, toolCallId)) {
      spawnToolCall(cmd, { modelMessage, id: toolCallId, name: rawCall.name, argsJson: rawCall.argsJson });
    }
  }

  if (update.error) {
    next = appendTextToMessage(next, `\n[error] ${update.error}`);
    next = { ...next, status: 'error' };
  } else if (update.done) {
    next = { ...next, status: 'complete' };
  }

  if (next !== current) {
    cmd.add(modelMessage, Message, next);
  }

  if (update.done) {
    cmd.remove(modelMessage, Streaming);
    cmd.despawn(request);
  }
}

function appendFunctionCallPart(
  message: MessageData,
  call: { id: string; name: string; argsJson: string }
): MessageData {
  let args: unknown = {};
  try {
    args = call.argsJson ? JSON.parse(call.argsJson) : {};
  } catch {
    args = call.argsJson;
  }

  const part: ContentPart = { type: 'functionCall', id: call.id, name: call.name, args };
  return { ...message, content: { ...message.content, parts: [...message.content.parts, part] } };
}

function appendTextToMessage(message: MessageData, delta: string): MessageData {
  if (!delta) return message;
  const parts = [...message.content.parts];
  const last = parts[parts.length - 1];
  if (last?.type === 'text') {
    parts[parts.length - 1] = { ...last, text: last.text + delta };
  } else {
    parts.push({ type: 'text', text: delta });
  }
  return { ...message, content: { ...message.content, parts } };
}

function normalizeToolCallId(
  requestId: string,
  call: { id?: string; name: string; argsJson: string },
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
