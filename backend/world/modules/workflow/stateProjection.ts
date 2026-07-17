import type {
  ClientState,
  ConversationWorkflowSelectionRecord,
  WorkflowRecord,
  ModelProfileRecord,
  ModelProfileScopeLinkRecord,
  SystemPromptRecord,
  SystemPromptScopeLinkRecord,
  ToolPolicyRecord
} from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { AgentRun } from '../agentRun/components';
import { Conversation } from '../chat/components';
import {
  ConversationWorkflowSelection,
  Workflow,
  ModelProfile,
  ModelProfileScopeLink,
  SystemPrompt,
  SystemPromptScopeLink,
  ToolPolicy
} from './components';

export const workflowStateProjectionReads: AccessDeclaration = {
  components: [
    Agent,
    AgentRun,
    Conversation,
    Workflow,
    ToolPolicy,
    SystemPrompt,
    SystemPromptScopeLink,
    ModelProfile,
    ModelProfileScopeLink,
    ConversationWorkflowSelection
  ]
};

export function projectWorkflowState(world: WorldReader): Partial<ClientState> {
  const workflows: WorkflowRecord[] = world.query(Workflow).map((entity) => ({ ...world.get(entity, Workflow)! }));
  const toolPolicies: ToolPolicyRecord[] = world.query(ToolPolicy).map((entity) => ({ ...world.get(entity, ToolPolicy)! }));
  const systemPrompts: SystemPromptRecord[] = world.query(SystemPrompt).map((entity) => ({ ...world.get(entity, SystemPrompt)! }));
  const modelProfiles: ModelProfileRecord[] = world.query(ModelProfile).map((entity) => ({ ...world.get(entity, ModelProfile)! }));

  const systemPromptScopeLinks: SystemPromptScopeLinkRecord[] = world
    .query(SystemPromptScopeLink)
    .map((entity) => buildSystemPromptScopeLinkRecord(world, entity))
    .filter((item): item is SystemPromptScopeLinkRecord => item !== undefined);

  const modelProfileScopeLinks: ModelProfileScopeLinkRecord[] = world
    .query(ModelProfileScopeLink)
    .map((entity) => buildModelProfileScopeLinkRecord(world, entity))
    .filter((item): item is ModelProfileScopeLinkRecord => item !== undefined);

  const conversationWorkflowSelections: ConversationWorkflowSelectionRecord[] = world
    .query(ConversationWorkflowSelection)
    .map((entity) => buildConversationWorkflowSelectionRecord(world, entity))
    .filter((item): item is ConversationWorkflowSelectionRecord => item !== undefined);

  return {
    workflows,
    toolPolicies,
    systemPrompts,
    systemPromptScopeLinks,
    modelProfiles,
    modelProfileScopeLinks,
    conversationWorkflowSelections
  };
}

function buildSystemPromptScopeLinkRecord(world: WorldReader, entity: number): SystemPromptScopeLinkRecord | undefined {
  const link = world.get(entity, SystemPromptScopeLink);
  if (!link) return undefined;
  const prompt = world.get(link.systemPrompt, SystemPrompt);
  if (!prompt) return undefined;
  const scopeId = scopeIdForLink(world, link);
  if (link.scopeKind !== 'global' && !scopeId) return undefined;
  return {
    id: link.id,
    scopeKind: link.scopeKind,
    ...(scopeId ? { scopeId } : {}),
    systemPromptId: prompt.id,
    role: link.role,
    ...(link.order !== undefined ? { order: link.order } : {}),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function buildModelProfileScopeLinkRecord(world: WorldReader, entity: number): ModelProfileScopeLinkRecord | undefined {
  const link = world.get(entity, ModelProfileScopeLink);
  if (!link) return undefined;
  const profile = world.get(link.modelProfile, ModelProfile);
  if (!profile) return undefined;
  const scopeId = scopeIdForLink(world, link);
  if (link.scopeKind !== 'global' && !scopeId) return undefined;
  return {
    id: link.id,
    scopeKind: link.scopeKind,
    ...(scopeId ? { scopeId } : {}),
    modelProfileId: profile.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function buildConversationWorkflowSelectionRecord(world: WorldReader, entity: number): ConversationWorkflowSelectionRecord | undefined {
  const selection = world.get(entity, ConversationWorkflowSelection);
  if (!selection) return undefined;
  const conversation = world.get(selection.conversation, Conversation);
  if (!conversation) return undefined;
  const workflow = selection.workflow !== undefined ? world.get(selection.workflow, Workflow) : undefined;
  if (selection.scopeKind === 'workflow' && !workflow) return undefined;
  return {
    id: selection.id,
    conversationId: conversation.id,
    scopeKind: selection.scopeKind,
    ...(workflow ? { workflowId: workflow.id } : {}),
    role: selection.role,
    createdAt: selection.createdAt,
    updatedAt: selection.updatedAt
  };
}

type ScopeLink = { scopeKind: string; scopeId?: string; agent?: number; workflow?: number; conversation?: number; run?: number };

function scopeIdForLink(world: WorldReader, link: ScopeLink): string | undefined {
  if (link.scopeKind === 'global') return undefined;
  if (link.scopeId) return link.scopeId;
  switch (link.scopeKind) {
    case 'agent': return link.agent !== undefined ? world.get(link.agent, Agent)?.id : undefined;
    case 'workflow': return link.workflow !== undefined ? world.get(link.workflow, Workflow)?.id : undefined;
    case 'conversation': return link.conversation !== undefined ? world.get(link.conversation, Conversation)?.id : undefined;
    case 'run': return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
    default: return undefined;
  }
}
