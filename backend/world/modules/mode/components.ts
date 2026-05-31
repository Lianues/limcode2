import { defineComponent, Entity } from '../../../ecs/types';
import type { AgentModeRole, LlmProviderKind, ModeBindingRole, ToolApprovalMode } from '../../../../shared/protocol';

export interface AgentModeData {
  id: string;
  name: string;
  description?: string;
}
export const AgentMode = defineComponent<AgentModeData>('AgentMode');

export interface ToolPolicyData {
  id: string;
  name: string;
  allowedTools: string[];
  approvalMode: ToolApprovalMode;
}
export const ToolPolicy = defineComponent<ToolPolicyData>('ToolPolicy');

export interface SystemPromptData {
  id: string;
  name: string;
  text: string;
}
export const SystemPrompt = defineComponent<SystemPromptData>('SystemPrompt');

export interface ModelProfileData {
  id: string;
  name: string;
  provider: LlmProviderKind;
  model: string;
  temperature?: number;
}
export const ModelProfile = defineComponent<ModelProfileData>('ModelProfile');

export interface AgentModeLinkData {
  id: string;
  agent: Entity;
  mode: Entity;
  role: AgentModeRole;
  createdAt: number;
  updatedAt: number;
}
export const AgentModeLink = defineComponent<AgentModeLinkData>('AgentModeLink');

export interface ModeToolPolicyLinkData {
  id: string;
  mode: Entity;
  toolPolicy: Entity;
  role: ModeBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const ModeToolPolicyLink = defineComponent<ModeToolPolicyLinkData>('ModeToolPolicyLink');

export interface ModeSystemPromptLinkData {
  id: string;
  mode: Entity;
  systemPrompt: Entity;
  role: ModeBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const ModeSystemPromptLink = defineComponent<ModeSystemPromptLinkData>('ModeSystemPromptLink');

export interface ModeModelProfileLinkData {
  id: string;
  mode: Entity;
  modelProfile: Entity;
  role: ModeBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const ModeModelProfileLink = defineComponent<ModeModelProfileLinkData>('ModeModelProfileLink');
