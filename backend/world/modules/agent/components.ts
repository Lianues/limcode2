import { defineComponent, type Entity } from '../../../ecs/types';
import type { AgentConversationRole, AgentSource, ConversationAgentSelectionRole } from '../../../../shared/protocol';

export interface AgentData {
  id: string;
  name: string;
  description?: string;
  source: AgentSource;
}
export const Agent = defineComponent<AgentData>('Agent');

export interface AgentConversationLinkData {
  id: string;
  agent: Entity;
  conversation: Entity;
  role: AgentConversationRole;
  createdAt: number;
  updatedAt: number;
}
export const AgentConversationLink = defineComponent<AgentConversationLinkData>('AgentConversationLink');

export interface ConversationAgentSelectionData {
  id: string;
  conversation: Entity;
  agent: Entity;
  role: ConversationAgentSelectionRole;
  createdAt: number;
  updatedAt: number;
}
export const ConversationAgentSelection = defineComponent<ConversationAgentSelectionData>('ConversationAgentSelection');

export const AgentKind = defineComponent<{ kind: string }>('AgentKind');
export const AgentStatus = defineComponent<{ status: 'idle' | 'thinking' | 'running' | 'done' | 'error' }>('AgentStatus');
