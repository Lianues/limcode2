import type { AgentConversationLinkRecord, AgentRecord, ClientState, ConversationAgentSelectionRecord } from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Conversation } from '../chat/components';
import {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus,
  ConversationAgentSelection
} from './components';
import { isRunAgentTemporaryId, projectedAgentSource } from './identity';

export const agentStateProjectionReads: AccessDeclaration = {
  components: [
    Agent,
    AgentConversationLink,
    ConversationAgentSelection,
    AgentKind,
    AgentStatus,
    Conversation
  ]
};

export function projectAgentState(world: WorldReader): Partial<ClientState> {
  const agents: AgentRecord[] = world.query(Agent).map((entity) => {
    const agent = world.get(entity, Agent)!;
    const kind = world.get(entity, AgentKind)?.kind ?? 'unknown';
    return {
      id: agent.id,
      name: agent.name,
      ...(agent.description ? { description: agent.description } : {}),
      kind,
      source: projectedAgentSource(agent.source),
      status: world.get(entity, AgentStatus)?.status ?? 'idle',
      ...(isRunAgentTemporaryId(agent.id, kind) ? { runtimeRole: 'mirror' as const, typeAgentId: kind } : {})
    };
  });

  const agentConversationLinks: AgentConversationLinkRecord[] = world
    .query(AgentConversationLink)
    .map((entity) => buildAgentConversationLinkRecord(world, entity))
    .filter((item): item is AgentConversationLinkRecord => item !== undefined);

  const conversationAgentSelections: ConversationAgentSelectionRecord[] = world
    .query(ConversationAgentSelection)
    .map((entity) => buildConversationAgentSelectionRecord(world, entity))
    .filter((item): item is ConversationAgentSelectionRecord => item !== undefined);

  return { agents, agentConversationLinks, conversationAgentSelections };
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

function buildConversationAgentSelectionRecord(world: WorldReader, entity: number): ConversationAgentSelectionRecord | undefined {
  const selection = world.get(entity, ConversationAgentSelection);
  if (!selection) return undefined;
  const agent = world.get(selection.agent, Agent);
  const conversation = world.get(selection.conversation, Conversation);
  if (!agent || !conversation) return undefined;
  return {
    id: selection.id,
    conversationId: conversation.id,
    agentId: agent.id,
    role: selection.role,
    createdAt: selection.createdAt,
    updatedAt: selection.updatedAt
  };
}
