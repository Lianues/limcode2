import type { ClientState, ToolCallEventRecord, ToolCallRecord } from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Message, PartOf } from '../chat/components';
import { ToolCall, ToolCallEvent, ToolResultConsumed, ToolState } from './components';

export const toolsStateProjectionReads: AccessDeclaration = {
  components: [Message, PartOf, ToolCall, ToolState, ToolCallEvent, ToolResultConsumed]
};

export function projectToolsState(world: WorldReader): Partial<ClientState> {
  const toolCalls = world
    .query(ToolCall, ToolState, PartOf)
    .map((entity) => buildToolCallRecord(world, entity))
    .filter((item): item is ToolCallRecord => item !== undefined);

  const toolCallEvents = world
    .query(ToolCallEvent, PartOf)
    .map((entity) => buildToolCallEventRecord(world, entity))
    .filter((item): item is ToolCallEventRecord => item !== undefined)
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));

  return { toolCalls, toolCallEvents };
}

function buildToolCallRecord(world: WorldReader, entity: number): ToolCallRecord | undefined {
  const call = world.get(entity, ToolCall);
  const state = world.get(entity, ToolState);
  const messageEntity = world.get(entity, PartOf)?.parent;
  if (!call || !state || messageEntity === undefined) return undefined;

  const message = world.get(messageEntity, Message);
  if (!message) return undefined;

  return {
    id: call.id,
    messageId: message.id,
    name: call.name,
    functionCallId: call.functionCallId,
    args: call.argsJson,
    status: state.status,
    ...(state.result !== undefined ? { result: state.result } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
    ...(state.progress !== undefined ? { progress: state.progress } : {}),
    ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
    createdAt: call.createdAt,
    updatedAt: state.updatedAt
  };
}

function buildToolCallEventRecord(world: WorldReader, entity: number): ToolCallEventRecord | undefined {
  const event = world.get(entity, ToolCallEvent);
  if (!event) return undefined;
  return { ...event };
}
