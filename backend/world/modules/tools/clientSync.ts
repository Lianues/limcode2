import type { ClientPatchOp, ClientState, ToolCallRecord } from '../../../../shared/protocol';
import type { WorldReader } from '../../../ecs/types';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor, type ClientStateSlice } from '../../clientSync/contributors';
import { Message, PartOf } from '../chat/components';
import { PendingTool, RunningTool, ToolCall, ToolCompleted, ToolFailed, ToolResult } from './components';

export function projectToolsClientState(world: WorldReader): ClientStateSlice {
  const toolCalls = world
    .query(ToolCall, PartOf)
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
  reads: { components: [Message, PartOf, PendingTool, RunningTool, ToolCall, ToolCompleted, ToolFailed, ToolResult] },
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
  const messageEntity = world.get(entity, PartOf)?.parent;
  if (!call || messageEntity === undefined) return undefined;

  const message = world.get(messageEntity, Message);
  if (!message) return undefined;

  const result = world.get(entity, ToolResult);
  return {
    id: call.id,
    messageId: message.id,
    name: call.name,
    functionCallId: call.functionCallId,
    args: call.argsJson,
    status: world.has(entity, PendingTool)
      ? 'pending'
      : world.has(entity, RunningTool)
        ? 'running'
        : world.has(entity, ToolFailed)
          ? 'failed'
          : world.has(entity, ToolCompleted)
            ? 'done'
            : 'pending',
    ...(result ? { result: result.output } : {})
  };
}
