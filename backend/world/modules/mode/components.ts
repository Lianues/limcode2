import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  ConfigScopeBindingRole,
  ConfigScopeKind,
  ConversationModeScopeKind,
  ConversationModeSelectionRole,
  LlmProviderKind,
  ModeIconKey,
  ModeSource,
  ToolPolicyPresetKind,
  ToolPolicySourceConfigRecord,
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
  preset?: ToolPolicyPresetKind;
  toolConfigs?: Record<string, ToolPolicyToolConfigRecord>;
  sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>;
}
export const ToolPolicy = defineComponent<ToolPolicyData>('ToolPolicy');

export interface SystemPromptData {
  id: string;
  name: string;
  text: string;
}
export const SystemPrompt = defineComponent<SystemPromptData>('SystemPrompt');

export interface SystemPromptScopeLinkData {
  id: string;
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  systemPrompt: Entity;
  agent?: Entity;
  mode?: Entity;
  conversation?: Entity;
  run?: Entity;
  role: ConfigScopeBindingRole;
  order?: number;
  createdAt: number;
  updatedAt: number;
}
export const SystemPromptScopeLink = defineComponent<SystemPromptScopeLinkData>('SystemPromptScopeLink');

export interface ModelProfileData {
  id: string;
  name: string;
  providerConfigId?: string;
  provider?: LlmProviderKind;
  model: string;
}
export const ModelProfile = defineComponent<ModelProfileData>('ModelProfile');

export interface ModelProfileScopeLinkData {
  id: string;
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  modelProfile: Entity;
  agent?: Entity;
  mode?: Entity;
  conversation?: Entity;
  run?: Entity;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const ModelProfileScopeLink = defineComponent<ModelProfileScopeLinkData>('ModelProfileScopeLink');

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
