import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  AgentModeRole,
  ConversationModeScopeKind,
  ConversationModeSelectionRole,
  LlmProviderKind,
  ModeBindingRole,
  ModeIconKey,
  ModeSource,
  ToolPolicyToolConfigRecord
} from '../../../../shared/protocol';

export interface ModeData {
  id: string;
  name: string;
  description?: string;
  source: ModeSource;
  icon?: ModeIconKey;
  createdAt: number;
  updatedAt: number;
}
export const Mode = defineComponent<ModeData>('Mode');

export interface ToolPolicyData {
  id: string;
  name: string;
  allowedTools: string[];
  toolConfigs?: Record<string, ToolPolicyToolConfigRecord>;
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

export interface ConversationModeSelectionData {
  id: string;
  conversation: Entity;
  scopeKind: ConversationModeScopeKind;
  mode?: Entity;
  role: ConversationModeSelectionRole;
  createdAt: number;
  updatedAt: number;
}
export const ConversationModeSelection = defineComponent<ConversationModeSelectionData>('ConversationModeSelection');

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
