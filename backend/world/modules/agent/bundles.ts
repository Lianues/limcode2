import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import { Conversation, PartOf, Message } from '../chat/components';
import { spawnConversation, spawnUserMessage } from '../chat/bundles';
import {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus
} from './components';
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
} from '../mode/components';
import type { AgentBlueprint, AgentModeBlueprint } from './blueprints';
import type { AgentModeRole } from '../../../../shared/protocol';

export const AgentFromBlueprintBundle = defineBundle({
  name: 'AgentFromBlueprintBundle',
  writes: [
    Agent,
    AgentKind,
    AgentStatus,
    AgentMode,
    ToolPolicy,
    ApprovalPolicy,
    SystemPrompt,
    ModelProfile,
    AgentModeLink,
    ModeToolPolicyLink,
    ModeApprovalPolicyLink,
    ModeSystemPromptLink,
    ModeModelProfileLink,
    Conversation,
    AgentConversationLink,
    Message,
    PartOf
  ],
  mutationMode: 'create',
  spawns: true
});

export interface SpawnAgentFromBlueprintInput {
  blueprint: AgentBlueprint;
  agentId: string;
  conversationId: string;
  agentName?: string;
  initialMessage?: string;
  conversationTitle?: string;
}

export interface SpawnAgentFromBlueprintResult {
  agent: Entity;
  conversation: Entity;
  link: Entity;
}

export function spawnAgentProfileFromBlueprint(
  cmd: CommandSink,
  input: { blueprint: AgentBlueprint; agentId: string; agentName?: string }
): Entity {
  const agent = cmd.spawn();
  cmd.add(agent, Agent, { id: input.agentId, name: input.agentName ?? input.blueprint.name });
  cmd.add(agent, AgentKind, { kind: input.blueprint.kind });
  cmd.add(agent, AgentStatus, { status: 'idle' });

  for (const modeBlueprint of input.blueprint.modes) {
    spawnModeFromBlueprint(cmd, {
      agent,
      agentId: input.agentId,
      blueprint: modeBlueprint,
      isDefault: modeBlueprint.id === input.blueprint.defaultModeId
    });
  }

  return agent;
}

export function spawnAgentFromBlueprint(
  cmd: CommandSink,
  input: SpawnAgentFromBlueprintInput
): SpawnAgentFromBlueprintResult {
  const agent = spawnAgentProfileFromBlueprint(cmd, input);

  const conversation = spawnConversation(cmd, { id: input.conversationId, title: input.conversationTitle });
  const link = linkAgentToConversation(cmd, { agent, conversation, role: 'default' });

  if (input.initialMessage?.trim()) {
    spawnUserMessage(cmd, conversation, input.initialMessage.trim());
  }

  return { agent, conversation, link };
}

export function linkAgentToConversation(
  cmd: CommandSink,
  input: { agent: Entity; conversation: Entity; role?: 'default' | 'participant' | 'reviewer' }
): Entity {
  const link = cmd.spawn();
  const now = Date.now();
  cmd.add(link, AgentConversationLink, {
    id: `acl${link}`,
    agent: input.agent,
    conversation: input.conversation,
    role: input.role ?? 'participant',
    createdAt: now,
    updatedAt: now
  });
  return link;
}

function spawnModeFromBlueprint(
  cmd: CommandSink,
  input: { agent: Entity; agentId: string; blueprint: AgentModeBlueprint; isDefault: boolean }
): Entity {
  const now = Date.now();
  const mode = cmd.spawn();
  const modeId = modeIdFor(input.agentId, input.blueprint.id);
  cmd.add(mode, AgentMode, {
    id: modeId,
    name: input.blueprint.name,
    description: input.blueprint.description
  });

  const modeRoles: AgentModeRole[] = input.isDefault ? ['active', 'default'] : ['available'];
  for (const role of modeRoles) {
    const modeLink = cmd.spawn();
    cmd.add(modeLink, AgentModeLink, {
      id: `agent-mode:${role}:${input.agentId}:${modeId}`,
      agent: input.agent,
      mode,
      role,
      createdAt: now,
      updatedAt: now
    });
  }

  const toolPolicy = cmd.spawn();
  const toolPolicyId = `${modeId}:tool-policy`;
  cmd.add(toolPolicy, ToolPolicy, {
    id: toolPolicyId,
    name: input.blueprint.toolPolicy.name ?? `${input.blueprint.name} Tools`,
    allowedTools: input.blueprint.toolPolicy.allowedTools
  });
  const toolPolicyLink = cmd.spawn();
  cmd.add(toolPolicyLink, ModeToolPolicyLink, {
    id: `mode-tool-policy:${modeId}:${toolPolicyId}`,
    mode,
    toolPolicy,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });

  const approvalPolicy = cmd.spawn();
  const approvalPolicyId = `${modeId}:approval-policy`;
  cmd.add(approvalPolicy, ApprovalPolicy, {
    id: approvalPolicyId,
    name: input.blueprint.approvalPolicy.name ?? `${input.blueprint.name} Approval`,
    mode: input.blueprint.approvalPolicy.mode,
    allowInteractiveApproval: input.blueprint.approvalPolicy.allowInteractiveApproval
  });
  const approvalPolicyLink = cmd.spawn();
  cmd.add(approvalPolicyLink, ModeApprovalPolicyLink, {
    id: `mode-approval-policy:${modeId}:${approvalPolicyId}`,
    mode,
    approvalPolicy,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });

  const systemPrompt = cmd.spawn();
  const systemPromptId = `${modeId}:system-prompt`;
  cmd.add(systemPrompt, SystemPrompt, {
    id: systemPromptId,
    name: `${input.blueprint.name} System Prompt`,
    text: input.blueprint.systemPrompt
  });
  const systemPromptLink = cmd.spawn();
  cmd.add(systemPromptLink, ModeSystemPromptLink, {
    id: `mode-system-prompt:${modeId}:${systemPromptId}`,
    mode,
    systemPrompt,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });

  const modelProfile = cmd.spawn();
  const modelProfileId = `${modeId}:model-profile`;
  cmd.add(modelProfile, ModelProfile, {
    id: modelProfileId,
    name: input.blueprint.model.name ?? `${input.blueprint.name} Model`,
    provider: input.blueprint.model.provider,
    model: input.blueprint.model.model
  });
  const modelProfileLink = cmd.spawn();
  cmd.add(modelProfileLink, ModeModelProfileLink, {
    id: `mode-model-profile:${modeId}:${modelProfileId}`,
    mode,
    modelProfile,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });

  return mode;
}

function modeIdFor(agentId: string, localModeId: string): string {
  return `${agentId}:mode:${localModeId}`;
}
