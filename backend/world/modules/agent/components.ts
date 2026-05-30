import { defineComponent, Entity } from '../../../ecs/types';
import type { AgentConversationRole } from '../../../../shared/protocol';
import type { LlmProviderKind } from '../llm/contracts';

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

export interface ModelProfileData {
  provider: LlmProviderKind;
  model: string;
  temperature?: number;
}
export const ModelProfile = defineComponent<ModelProfileData>('ModelProfile');

export interface ToolPolicyData {
  allowedTools: string[];
  approvalMode: 'never' | 'onRisk' | 'always';
}
export const ToolPolicy = defineComponent<ToolPolicyData>('ToolPolicy');

export const SystemPrompt = defineComponent<{ text: string }>('SystemPrompt');
