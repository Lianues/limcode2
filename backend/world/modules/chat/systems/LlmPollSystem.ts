import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { LlmEventType } from '../../llm/events';
import { spawnToolCall, ToolCallBundle } from '../../tools/bundles';
import { LlmRequest, Message, Streaming } from '../components';

const LlmRequestsByIdQuery = defineQuery({
  name: 'LlmRequestsById',
  all: [LlmRequest],
  read: [LlmRequest],
  remove: [LlmRequest],
  mutationMode: 'consume',
  role: 'lookup'
});

const AssistantMessagesQuery = defineQuery({
  name: 'AssistantMessages',
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
    queries: [LlmRequestsByIdQuery, AssistantMessagesQuery],
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
      const assistant = assistantOf(world, payload.requestId);
      if (assistant === undefined) continue;
      for (const call of payload.calls) spawnToolCall(cmd, { assistant, name: call.name, argsJson: call.argsJson });
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
function assistantOf(world: WorldReader, requestId: string): Entity | undefined {
  const request = requestOf(world, requestId);
  return request === undefined ? undefined : world.get(request, LlmRequest)?.assistantEntity;
}

function appendDelta(world: WorldReader, cmd: CommandSink, requestId: string, delta: string): void {
  const assistant = assistantOf(world, requestId);
  if (assistant === undefined || !delta) return;
  const message = world.get(assistant, Message);
  if (message) cmd.add(assistant, Message, { ...message, text: message.text + delta });
}

function finalize(world: WorldReader, cmd: CommandSink, requestId: string, status: 'complete' | 'error', errorMessage?: string, pendingDelta = ''): void {
  const request = requestOf(world, requestId);
  if (request === undefined) return;
  const data = world.get(request, LlmRequest);
  if (data) {
    const assistant = data.assistantEntity;
    const message = world.get(assistant, Message);
    if (message) {
      const baseText = `${message.text}${pendingDelta}`;
      const text = errorMessage ? `${baseText}\n[error] ${errorMessage}` : baseText;
      cmd.add(assistant, Message, { ...message, text, status });
    }
    cmd.remove(assistant, Streaming);
  }
  cmd.despawn(request);
}
