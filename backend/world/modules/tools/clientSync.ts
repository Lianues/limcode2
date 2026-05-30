import type { ClientPatchOp, ClientState, ToolCallEventRecord, ToolCallRecord } from '../../../../shared/protocol';
import type { WorldReader } from '../../../ecs/types';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor, type ClientStateSlice } from '../../clientSync/contributors';
import { Message, PartOf } from '../chat/components';
import { ToolCall, ToolCallEvent, ToolResultConsumed, ToolState } from './components';

export function projectToolsClientState(world: WorldReader): ClientStateSlice {
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

export function diffToolsClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  return [
    ...diffUpsertRemove(
      prev.toolCalls,
      next.toolCalls,
      (toolCall): ClientPatchOp => ({ kind: 'toolcall.upsert', toolCall }),
      (id): ClientPatchOp => ({ kind: 'toolcall.remove', id })
    ),
    ...diffToolCallEvents(prev.toolCallEvents ?? [], next.toolCallEvents ?? [])
  ];
}

export const toolsClientSyncContributor = defineClientStateContributor({
  key: 'tools',
  reads: { components: [Message, PartOf, ToolCall, ToolState, ToolCallEvent, ToolResultConsumed] },
  project: projectToolsClientState,
  diff: diffToolsClientState,
  worker: {
    modulePath: '../world/modules/tools/clientSync',
    projectExport: 'projectToolsClientState',
    diffExport: 'diffToolsClientState'
  }
});

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

function diffToolCallEvents(prev: ToolCallEventRecord[], next: ToolCallEventRecord[]): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  const prevIds = new Set(prev.map((event) => event.id));
  const nextIds = new Set(next.map((event) => event.id));
  for (const event of next) {
    if (!prevIds.has(event.id)) patches.push({ kind: 'toolcallEvent.append', event });
  }
  for (const id of prevIds) {
    if (!nextIds.has(id)) patches.push({ kind: 'toolcallEvent.remove', id });
  }
  return patches;
}
