import type {
  AgentModeLinkRecord,
  AgentModeRecord,
  ApprovalPolicyRecord,
  ClientState,
  ModeApprovalPolicyLinkRecord,
  ModeModelProfileLinkRecord,
  ModeSystemPromptLinkRecord,
  ModeToolPolicyLinkRecord,
  ModelProfileRecord,
  SystemPromptRecord,
  ToolPolicyRecord
} from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import {
  AgentMode,
  AgentModeLink,
  ApprovalPolicy,
  ModeApprovalPolicyLink,
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
    AgentMode,
    ToolPolicy,
    ApprovalPolicy,
    SystemPrompt,
    ModelProfile,
    AgentModeLink,
    ModeToolPolicyLink,
    ModeApprovalPolicyLink,
    ModeSystemPromptLink,
    ModeModelProfileLink
  ]
};

export function projectModeState(world: WorldReader): Partial<ClientState> {
  const agentModes: AgentModeRecord[] = world.query(AgentMode).map((entity) => ({ ...world.get(entity, AgentMode)! }));
  const toolPolicies: ToolPolicyRecord[] = world.query(ToolPolicy).map((entity) => ({ ...world.get(entity, ToolPolicy)! }));
  const approvalPolicies: ApprovalPolicyRecord[] = world.query(ApprovalPolicy).map((entity) => ({ ...world.get(entity, ApprovalPolicy)! }));
  const systemPrompts: SystemPromptRecord[] = world.query(SystemPrompt).map((entity) => ({ ...world.get(entity, SystemPrompt)! }));
  const modelProfiles: ModelProfileRecord[] = world.query(ModelProfile).map((entity) => ({ ...world.get(entity, ModelProfile)! }));

  const agentModeLinks: AgentModeLinkRecord[] = world
    .query(AgentModeLink)
    .map((entity) => buildAgentModeLinkRecord(world, entity))
    .filter((item): item is AgentModeLinkRecord => item !== undefined);
  const modeToolPolicyLinks: ModeToolPolicyLinkRecord[] = world
    .query(ModeToolPolicyLink)
    .map((entity) => buildModeToolPolicyLinkRecord(world, entity))
    .filter((item): item is ModeToolPolicyLinkRecord => item !== undefined);
  const modeApprovalPolicyLinks: ModeApprovalPolicyLinkRecord[] = world
    .query(ModeApprovalPolicyLink)
    .map((entity) => buildModeApprovalPolicyLinkRecord(world, entity))
    .filter((item): item is ModeApprovalPolicyLinkRecord => item !== undefined);
  const modeSystemPromptLinks: ModeSystemPromptLinkRecord[] = world
    .query(ModeSystemPromptLink)
    .map((entity) => buildModeSystemPromptLinkRecord(world, entity))
    .filter((item): item is ModeSystemPromptLinkRecord => item !== undefined);
  const modeModelProfileLinks: ModeModelProfileLinkRecord[] = world
    .query(ModeModelProfileLink)
    .map((entity) => buildModeModelProfileLinkRecord(world, entity))
    .filter((item): item is ModeModelProfileLinkRecord => item !== undefined);

  return {
    agentModes,
    toolPolicies,
    approvalPolicies,
    systemPrompts,
    modelProfiles,
    agentModeLinks,
    modeToolPolicyLinks,
    modeApprovalPolicyLinks,
    modeSystemPromptLinks,
    modeModelProfileLinks
  };
}

function buildAgentModeLinkRecord(world: WorldReader, entity: number): AgentModeLinkRecord | undefined {
  const link = world.get(entity, AgentModeLink);
  if (!link) return undefined;
  const agent = world.get(link.agent, Agent);
  const mode = world.get(link.mode, AgentMode);
  if (!agent || !mode) return undefined;
  return { id: link.id, agentId: agent.id, modeId: mode.id, role: link.role };
}

function buildModeToolPolicyLinkRecord(world: WorldReader, entity: number): ModeToolPolicyLinkRecord | undefined {
  const link = world.get(entity, ModeToolPolicyLink);
  if (!link) return undefined;
  const mode = world.get(link.mode, AgentMode);
  const toolPolicy = world.get(link.toolPolicy, ToolPolicy);
  if (!mode || !toolPolicy) return undefined;
  return { id: link.id, modeId: mode.id, toolPolicyId: toolPolicy.id, role: link.role };
}

function buildModeApprovalPolicyLinkRecord(world: WorldReader, entity: number): ModeApprovalPolicyLinkRecord | undefined {
  const link = world.get(entity, ModeApprovalPolicyLink);
  if (!link) return undefined;
  const mode = world.get(link.mode, AgentMode);
  const approvalPolicy = world.get(link.approvalPolicy, ApprovalPolicy);
  if (!mode || !approvalPolicy) return undefined;
  return { id: link.id, modeId: mode.id, approvalPolicyId: approvalPolicy.id, role: link.role };
}

function buildModeSystemPromptLinkRecord(world: WorldReader, entity: number): ModeSystemPromptLinkRecord | undefined {
  const link = world.get(entity, ModeSystemPromptLink);
  if (!link) return undefined;
  const mode = world.get(link.mode, AgentMode);
  const systemPrompt = world.get(link.systemPrompt, SystemPrompt);
  if (!mode || !systemPrompt) return undefined;
  return { id: link.id, modeId: mode.id, systemPromptId: systemPrompt.id, role: link.role };
}

function buildModeModelProfileLinkRecord(world: WorldReader, entity: number): ModeModelProfileLinkRecord | undefined {
  const link = world.get(entity, ModeModelProfileLink);
  if (!link) return undefined;
  const mode = world.get(link.mode, AgentMode);
  const modelProfile = world.get(link.modelProfile, ModelProfile);
  if (!mode || !modelProfile) return undefined;
  return { id: link.id, modeId: mode.id, modelProfileId: modelProfile.id, role: link.role };
}
