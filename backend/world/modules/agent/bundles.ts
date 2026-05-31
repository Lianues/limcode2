import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import { NeedsResponse, Message, PartOf, Session } from '../chat/components';
import { spawnUserMessage, spawnSession } from '../chat/bundles';
import {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus,
  ParentAgent
} from './components';
import {
  AgentMode,
  AgentModeLink,
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
    ParentAgent,
    AgentMode,
    ToolPolicy,
    SystemPrompt,
    ModelProfile,
    AgentModeLink,
    ModeToolPolicyLink,
    ModeSystemPromptLink,
    ModeModelProfileLink,
    Session,
    AgentConversationLink,
    Message,
    PartOf,
    NeedsResponse
  ],
  mutationMode: 'create',
  spawns: true
});

export interface SpawnAgentFromBlueprintInput {
  blueprint: AgentBlueprint;
  agentId: string;
  sessionId: string;
  agentName?: string;
  parentAgent?: Entity;
  initialTask?: string;
}

export interface SpawnAgentFromBlueprintResult {
  agent: Entity;
  session: Entity;
  link: Entity;
}

export function spawnAgentFromBlueprint(
  cmd: CommandSink,
  input: SpawnAgentFromBlueprintInput
): SpawnAgentFromBlueprintResult {
  const agent = cmd.spawn();
  cmd.add(agent, Agent, { id: input.agentId, name: input.agentName ?? input.blueprint.name });
  cmd.add(agent, AgentKind, { kind: input.blueprint.kind });
  cmd.add(agent, AgentStatus, { status: 'idle' });
  if (input.parentAgent !== undefined) {
    cmd.add(agent, ParentAgent, { parent: input.parentAgent });
  }

  for (const modeBlueprint of input.blueprint.modes) {
    spawnModeFromBlueprint(cmd, {
      agent,
      agentId: input.agentId,
      blueprint: modeBlueprint,
      isDefault: modeBlueprint.id === input.blueprint.defaultModeId
    });
  }

  const session = spawnSession(cmd, { id: input.sessionId });
  const link = cmd.spawn();
  const now = Date.now();
  cmd.add(link, AgentConversationLink, {
    id: `acl${link}`,
    agent,
    conversation: session,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });

  if (input.initialTask && input.initialTask.trim()) {
    spawnUserMessage(cmd, session, input.initialTask.trim());
    cmd.add(session, NeedsResponse, { since: Date.now() });
  }

  return { agent, session, link };
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
    allowedTools: input.blueprint.toolPolicy.allowedTools,
    approvalMode: input.blueprint.toolPolicy.approvalMode
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
    model: input.blueprint.model.model,
    temperature: input.blueprint.model.temperature
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
