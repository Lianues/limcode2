import type { ClientPatchOp, ClientState, ToolCallEventRecord } from '../../../../shared/protocol';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor } from '../../clientSync/contributors';
import { projectToolsState, toolsStateProjectionReads } from './stateProjection';

export const projectToolsClientState = projectToolsState;

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
  reads: toolsStateProjectionReads,
  project: projectToolsClientState,
  diff: diffToolsClientState,
  worker: {
    modulePath: '../world/modules/tools/clientSync',
    projectExport: 'projectToolsClientState',
    diffExport: 'diffToolsClientState'
  }
});

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
