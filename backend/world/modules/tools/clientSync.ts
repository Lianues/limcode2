import type { ClientPatchOp, ClientState, ToolCallRecord } from '../../../../shared/protocol';
import type { WorldReader } from '../../../ecs/types';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor, type ClientStateSlice } from '../../clientSync/contributors';
import { Message, PartOf } from '../chat/components';
import { ToolCall, ToolResultConsumed, ToolState } from './components';

export function projectToolsClientState(world: WorldReader): ClientStateSlice {
  const toolCalls = world
    .query(ToolCall, ToolState, PartOf)
    .map((entity) => buildToolCallRecord(world, entity))
    .filter((item): item is ToolCallRecord => item !== undefined);
  return { toolCalls };
}

export function diffToolsClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  return diffUpsertRemove(
    prev.toolCalls,
    next.toolCalls,
    (toolCall): ClientPatchOp => ({ kind: 'toolcall.upsert', toolCall }),
    (id): ClientPatchOp => ({ kind: 'toolcall.remove', id })
  );
}

export const toolsClientSyncContributor = defineClientStateContributor({
  key: 'tools',
  reads: { components: [Message, PartOf, ToolCall, ToolState, ToolResultConsumed] },
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
    createdAt: call.createdAt,
    updatedAt: state.updatedAt
  };
}
