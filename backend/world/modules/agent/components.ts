import { defineComponent, Entity } from '../../../ecs/types';
import type { AgentConversationRole } from '../../../../shared/protocol';

export interface AgentData {
  id: string;
  name: string;
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

export const AgentKind = defineComponent<{ kind: string }>('AgentKind');
export const ParentAgent = defineComponent<{ parent: Entity }>('ParentAgent');
export const AgentStatus = defineComponent<{ status: 'idle' | 'thinking' | 'running' | 'done' | 'error' }>('AgentStatus');
