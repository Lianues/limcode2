import type { AgentConversationLinkRecord, AgentRecord, ClientState } from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Conversation } from '../chat/components';
import {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus
} from './components';

export const agentStateProjectionReads: AccessDeclaration = {
  components: [
    Agent,
    AgentConversationLink,
    AgentKind,
    AgentStatus,
    Conversation
  ]
};

export function projectAgentState(world: WorldReader): Partial<ClientState> {
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
