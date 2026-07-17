import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  ConfigScopeBindingRole,
  ConfigScopeKind,
  ConversationWorkflowScopeKind,
  ConversationWorkflowSelectionRole,
  LlmProviderKind,
  WorkflowIconKey,
  WorkflowSource,
  ToolPolicyPresetKind,
  ToolPolicySourceConfigRecord,
  ToolPolicyToolConfigRecord
} from '../../../../shared/protocol';

export interface WorkflowData {
  id: string;
  name: string;
  description?: string;
  source: WorkflowSource;
  icon?: WorkflowIconKey;
  createdAt: number;
  updatedAt: number;
}
export const Workflow = defineComponent<WorkflowData>('Workflow');

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
  workflow?: Entity;
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
  workflow?: Entity;
  conversation?: Entity;
  run?: Entity;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const ModelProfileScopeLink = defineComponent<ModelProfileScopeLinkData>('ModelProfileScopeLink');

export interface ConversationWorkflowSelectionData {
  id: string;
  conversation: Entity;
  scopeKind: ConversationWorkflowScopeKind;
  workflow?: Entity;
  role: ConversationWorkflowSelectionRole;
  createdAt: number;
  updatedAt: number;
}
export const ConversationWorkflowSelection = defineComponent<ConversationWorkflowSelectionData>('ConversationWorkflowSelection');
