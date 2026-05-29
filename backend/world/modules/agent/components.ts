import { defineComponent, Entity } from '../../../ecs/types';

export interface AgentData {
  id: string;
  name: string;
}
export const Agent = defineComponent<AgentData>('Agent');
export const OwnedByAgent = defineComponent<{ agent: Entity }>('OwnedByAgent');

export const AgentKind = defineComponent<{ kind: string }>('AgentKind');
export const ParentAgent = defineComponent<{ parent: Entity }>('ParentAgent');
export const AgentStatus = defineComponent<{ status: 'idle' | 'thinking' | 'running' | 'done' | 'error' }>('AgentStatus');

export interface ModelProfileData {
  provider: 'fake' | 'openai-compatible' | 'anthropic';
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
