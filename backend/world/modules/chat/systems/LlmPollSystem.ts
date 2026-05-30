import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { LlmEventType } from '../../llm/events';
import { spawnToolCall, ToolCallBundle } from '../../tools/bundles';
import { LlmRequest, Message, Streaming, type MessageData } from '../components';
import type { ContentPart } from '../../../../../shared/protocol';

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

export const LlmPollSystem = defineSystem({
  name: 'LlmPollSystem',
  worker: { modulePath: '../world/modules/chat/systems/LlmPollSystem', exportName: 'LlmPollSystem' },
  access: {
    queries: [LlmRequestsByIdQuery, ModelMessagesQuery],
    writes: { components: [Streaming] },
    events: { read: [LlmEventType.Delta, LlmEventType.ToolCall, LlmEventType.Done, LlmEventType.Error] },
    bundles: [ToolCallBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const deltasByRequest = new Map<string, string>();

    for (const payload of readEvents(ctx, LlmEventType.Delta)) {
      deltasByRequest.set(payload.requestId, `${deltasByRequest.get(payload.requestId) ?? ''}${payload.text}`);
    }

    for (const [requestId, delta] of deltasByRequest) {
      appendDelta(world, cmd, requestId, delta);
    }

    for (const payload of readEvents(ctx, LlmEventType.ToolCall)) {
      const modelMessage = modelMessageOf(world, payload.requestId);
      if (modelMessage === undefined) continue;
      for (const call of payload.calls) {
        const toolCallId = call.id || `tool-${payload.requestId}-${call.name}`;
        appendFunctionCall(world, cmd, modelMessage, { id: toolCallId, name: call.name, argsJson: call.argsJson });
        spawnToolCall(cmd, { modelMessage, id: toolCallId, name: call.name, argsJson: call.argsJson });
      }
    }

    const erroredRequests = new Set<string>();
    for (const payload of readEvents(ctx, LlmEventType.Error)) {
      erroredRequests.add(payload.requestId);
      finalize(world, cmd, payload.requestId, 'error', payload.message, deltasByRequest.get(payload.requestId) ?? '');
    }
    for (const payload of readEvents(ctx, LlmEventType.Done)) {
      if (!erroredRequests.has(payload.requestId)) finalize(world, cmd, payload.requestId, 'complete', undefined, deltasByRequest.get(payload.requestId) ?? '');
    }
  }
});

function requestOf(world: WorldReader, requestId: string): Entity | undefined {
  return world.query(LlmRequest).find((request) => world.get(request, LlmRequest)?.id === requestId);
}
function modelMessageOf(world: WorldReader, requestId: string): Entity | undefined {
  const request = requestOf(world, requestId);
  return request === undefined ? undefined : world.get(request, LlmRequest)?.modelMessageEntity;
}

function appendDelta(world: WorldReader, cmd: CommandSink, requestId: string, delta: string): void {
  const modelMessage = modelMessageOf(world, requestId);
  if (modelMessage === undefined || !delta) return;
  const message = world.get(modelMessage, Message);
  if (message) cmd.add(modelMessage, Message, appendTextToMessage(message, delta));
}

function appendFunctionCall(
  world: WorldReader,
  cmd: CommandSink,
  modelMessage: Entity,
  call: { id: string; name: string; argsJson: string }
): void {
  const message = world.get(modelMessage, Message);
  if (!message) return;

  let args: unknown = {};
  try {
    args = call.argsJson ? JSON.parse(call.argsJson) : {};
  } catch {
    args = call.argsJson;
  }

  const part: ContentPart = { type: 'functionCall', id: call.id, name: call.name, args };
  cmd.add(modelMessage, Message, { ...message, content: { ...message.content, parts: [...message.content.parts, part] } });
}

function finalize(world: WorldReader, cmd: CommandSink, requestId: string, status: 'complete' | 'error', errorMessage?: string, pendingDelta = ''): void {
  const request = requestOf(world, requestId);
  if (request === undefined) return;
  const data = world.get(request, LlmRequest);
  if (data) {
    const modelMessage = data.modelMessageEntity;
    const message = world.get(modelMessage, Message);
    if (message) {
      const withPending = pendingDelta ? appendTextToMessage(message, pendingDelta) : message;
      const withError = errorMessage ? appendTextToMessage(withPending, `\n[error] ${errorMessage}`) : withPending;
      cmd.add(modelMessage, Message, { ...withError, status });
    }
    cmd.remove(modelMessage, Streaming);
  }
  cmd.despawn(request);
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
