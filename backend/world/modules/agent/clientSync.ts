import type { ClientPatchOp, ClientState } from '../../../../shared/protocol';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor } from '../../clientSync/contributors';
import { agentStateProjectionReads, projectAgentState } from './stateProjection';

export const projectAgentClientState = projectAgentState;

export function diffAgentClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  patches.push(
    ...diffUpsertRemove(
      prev.agents,
      next.agents,
      (agent): ClientPatchOp => ({ kind: 'agent.upsert', agent }),
      (id): ClientPatchOp => ({ kind: 'agent.remove', id })
    )
  );
  patches.push(
    ...diffUpsertRemove(
      prev.agentConversationLinks,
      next.agentConversationLinks,
      (link): ClientPatchOp => ({ kind: 'agentConversationLink.upsert', link }),
      (id): ClientPatchOp => ({ kind: 'agentConversationLink.remove', id })
    )
  );
  return patches;
}

export const agentClientSyncContributor = defineClientStateContributor({
  key: 'agents',
  reads: agentStateProjectionReads,
  project: projectAgentClientState,
  diff: diffAgentClientState,
  worker: {
    modulePath: '../world/modules/agent/clientSync',
    projectExport: 'projectAgentClientState',
    diffExport: 'diffAgentClientState'
  }
});
