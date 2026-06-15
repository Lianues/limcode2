import type {
  AgentModeLinkRecord,
  ClientState,
  ConversationModeSelectionRecord,
  ModeModelProfileLinkRecord,
  ModeRecord,
  ModeSystemPromptLinkRecord,
  ModeToolPolicyLinkRecord,
  ModelProfileRecord,
  SystemPromptRecord,
  ToolPolicyRecord
} from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { Conversation } from '../chat/components';
import {
  AgentModeLink,
  ConversationModeSelection,
  Mode,
  ModeModelProfileLink,
  ModeSystemPromptLink,
  ModeToolPolicyLink,
  ModelProfile,
  SystemPrompt,
  ToolPolicy
} from './components';

export const modeStateProjectionReads: AccessDeclaration = {
  components: [
    Agent,
    Conversation,
    Mode,
    ToolPolicy,
    SystemPrompt,
    ModelProfile,
    AgentModeLink,
    ConversationModeSelection,
    ModeToolPolicyLink,
    ModeSystemPromptLink,
    ModeModelProfileLink
  ]
};

export function projectModeState(world: WorldReader): Partial<ClientState> {
  const modes: ModeRecord[] = world.query(Mode).map((entity) => ({ ...world.get(entity, Mode)! }));
  const toolPolicies: ToolPolicyRecord[] = world.query(ToolPolicy).map((entity) => ({ ...world.get(entity, ToolPolicy)! }));
  const systemPrompts: SystemPromptRecord[] = world.query(SystemPrompt).map((entity) => ({ ...world.get(entity, SystemPrompt)! }));
  const modelProfiles: ModelProfileRecord[] = world.query(ModelProfile).map((entity) => ({ ...world.get(entity, ModelProfile)! }));

  const agentModeLinks: AgentModeLinkRecord[] = world
    .query(AgentModeLink)
    .map((entity) => buildAgentModeLinkRecord(world, entity))
    .filter((item): item is AgentModeLinkRecord => item !== undefined);
  const conversationModeSelections: ConversationModeSelectionRecord[] = world
    .query(ConversationModeSelection)
    .map((entity) => buildConversationModeSelectionRecord(world, entity))
    .filter((item): item is ConversationModeSelectionRecord => item !== undefined);
  const modeToolPolicyLinks: ModeToolPolicyLinkRecord[] = world
    .query(ModeToolPolicyLink)
    .map((entity) => buildModeToolPolicyLinkRecord(world, entity))
    .filter((item): item is ModeToolPolicyLinkRecord => item !== undefined);
  const modeSystemPromptLinks: ModeSystemPromptLinkRecord[] = world
    .query(ModeSystemPromptLink)
    .map((entity) => buildModeSystemPromptLinkRecord(world, entity))
    .filter((item): item is ModeSystemPromptLinkRecord => item !== undefined);
  const modeModelProfileLinks: ModeModelProfileLinkRecord[] = world
    .query(ModeModelProfileLink)
    .map((entity) => buildModeModelProfileLinkRecord(world, entity))
    .filter((item): item is ModeModelProfileLinkRecord => item !== undefined);

  return {
    modes,
    toolPolicies,
    systemPrompts,
    modelProfiles,
    agentModeLinks,
    conversationModeSelections,
    modeToolPolicyLinks,
    modeSystemPromptLinks,
    modeModelProfileLinks
  };
}

function buildAgentModeLinkRecord(world: WorldReader, entity: number): AgentModeLinkRecord | undefined {
  const link = world.get(entity, AgentModeLink);
  if (!link) return undefined;
  const agent = world.get(link.agent, Agent);
  const mode = world.get(link.mode, Mode);
  if (!agent || !mode) return undefined;
  return { id: link.id, agentId: agent.id, modeId: mode.id, role: link.role };
}

function buildConversationModeSelectionRecord(world: WorldReader, entity: number): ConversationModeSelectionRecord | undefined {
  const selection = world.get(entity, ConversationModeSelection);
  if (!selection) return undefined;
  const conversation = world.get(selection.conversation, Conversation);
  if (!conversation) return undefined;
  const mode = selection.mode !== undefined ? world.get(selection.mode, Mode) : undefined;
  if (selection.scopeKind === 'mode' && !mode) return undefined;
  return {
    id: selection.id,
    conversationId: conversation.id,
    scopeKind: selection.scopeKind,
    ...(mode ? { modeId: mode.id } : {}),
    role: selection.role,
    createdAt: selection.createdAt,
    updatedAt: selection.updatedAt
  };
}

function buildModeToolPolicyLinkRecord(world: WorldReader, entity: number): ModeToolPolicyLinkRecord | undefined {
  const link = world.get(entity, ModeToolPolicyLink);
  if (!link) return undefined;
  const mode = world.get(link.mode, Mode);
  const toolPolicy = world.get(link.toolPolicy, ToolPolicy);
  if (!mode || !toolPolicy) return undefined;
  return { id: link.id, modeId: mode.id, toolPolicyId: toolPolicy.id, role: link.role };
}

function buildModeSystemPromptLinkRecord(world: WorldReader, entity: number): ModeSystemPromptLinkRecord | undefined {
  const link = world.get(entity, ModeSystemPromptLink);
  if (!link) return undefined;
  const mode = world.get(link.mode, Mode);
  const systemPrompt = world.get(link.systemPrompt, SystemPrompt);
  if (!mode || !systemPrompt) return undefined;
  return { id: link.id, modeId: mode.id, systemPromptId: systemPrompt.id, role: link.role };
}

function buildModeModelProfileLinkRecord(world: WorldReader, entity: number): ModeModelProfileLinkRecord | undefined {
  const link = world.get(entity, ModeModelProfileLink);
  if (!link) return undefined;
  const mode = world.get(link.mode, Mode);
  const modelProfile = world.get(link.modelProfile, ModelProfile);
  if (!mode || !modelProfile) return undefined;
  return { id: link.id, modeId: mode.id, modelProfileId: modelProfile.id, role: link.role };
}
