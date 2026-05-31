import type { AgentConversationLinkRecord, AgentRecord, ClientPatchOp, ClientState } from '../../../../shared/protocol';
import type { WorldReader } from '../../../ecs/types';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor, type ClientStateSlice } from '../../clientSync/contributors';
import { Conversation } from '../chat/components';
import {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus
} from './components';

export function projectAgentClientState(world: WorldReader): ClientStateSlice {
  const agents: AgentRecord[] = world.query(Agent).map((entity) => {
    const agent = world.get(entity, Agent)!;
    return {
      id: agent.id,
      name: agent.name,
      kind: world.get(entity, AgentKind)?.kind ?? 'unknown',
      status: world.get(entity, AgentStatus)?.status ?? 'idle'
    };
  });

  const agentConversationLinks: AgentConversationLinkRecord[] = world
    .query(AgentConversationLink)
    .map((entity) => buildAgentConversationLinkRecord(world, entity))
    .filter((item): item is AgentConversationLinkRecord => item !== undefined);

  return { agents, agentConversationLinks };
}

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
  reads: {
    components: [
      Agent,
      AgentConversationLink,
      AgentKind,
      AgentStatus,
      Conversation
    ]
  },
  project: projectAgentClientState,
  diff: diffAgentClientState,
  worker: {
    modulePath: '../world/modules/agent/clientSync',
    projectExport: 'projectAgentClientState',
    diffExport: 'diffAgentClientState'
  }
});

function buildAgentConversationLinkRecord(world: WorldReader, entity: number): AgentConversationLinkRecord | undefined {
  const link = world.get(entity, AgentConversationLink);
  if (!link) return undefined;

  const agent = world.get(link.agent, Agent);
  const conversation = world.get(link.conversation, Conversation);
  if (!agent || !conversation) return undefined;

  return {
    id: link.id,
    agentId: agent.id,
    conversationId: conversation.id,
    role: link.role
  };
}
