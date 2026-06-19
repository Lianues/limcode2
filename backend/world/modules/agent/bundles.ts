import { defineBundle, type CommandSink, type Entity, type WorldReader } from '../../../ecs/types';
import { Conversation, ConversationOriginLink, PartOf, Message } from '../chat/components';
import { spawnConversation, spawnConversationOriginLink, spawnUserMessage } from '../chat/bundles';
import {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus,
  ConversationAgentSelection
} from './components';
import {
  ConversationModeSelection,
  Mode,
  ModelProfile,
  ModelProfileScopeLink,
  SystemPrompt,
  SystemPromptScopeLink,
  ToolPolicy
} from '../mode/components';
import { selectGlobalModeForConversation } from '../mode/bundles';
import { ToolPolicyScopeLink } from '../tools/components';
import type { BuiltinAgentDefinition, BuiltinModeDefinition } from './blueprints';
import type { ConfigScopeKind, ToolPolicyScopeKind } from '../../../../shared/protocol';

export const AgentFromBlueprintBundle = defineBundle({
  name: 'AgentFromBlueprintBundle',
  writes: [
    Agent,
    AgentKind,
    AgentStatus,
    Mode,
    ToolPolicy,
    SystemPrompt,
    SystemPromptScopeLink,
    ModelProfile,
    ModelProfileScopeLink,
    ToolPolicyScopeLink,
    Conversation,
    ConversationOriginLink,
    ConversationModeSelection,
    AgentConversationLink,
    ConversationAgentSelection,
    Message,
    PartOf
  ],
  mutationMode: 'create',
  spawns: true
});

export interface SpawnAgentProfileInput {
  definition: BuiltinAgentDefinition;
  agentId?: string;
  agentName?: string;
  source?: 'builtin' | 'user';
}

export interface SpawnAgentWithConversationInput extends SpawnAgentProfileInput {
  conversationId: string;
  initialMessage?: string;
  conversationTitle?: string;
}

export interface SpawnAgentWithConversationResult {
  agent: Entity;
  conversation: Entity;
  link: Entity;
  selection: Entity;
}

export function spawnAgentProfileFromBlueprint(cmd: CommandSink, input: SpawnAgentProfileInput): Entity {
  const definition = input.definition;
  const agentId = input.agentId ?? definition.id;
  const agent = cmd.spawn();
  cmd.add(agent, Agent, {
    id: agentId,
    name: input.agentName ?? definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    source: input.source ?? 'builtin'
  });
  cmd.add(agent, AgentKind, { kind: definition.kind });
  cmd.add(agent, AgentStatus, { status: 'idle' });

  const prompt = spawnSystemPrompt(cmd, {
    id: `system-prompt:agent:${agentId}`,
    name: `${definition.name} Prompt`,
    text: definition.systemPrompt
  });
  linkSystemPromptToScope(cmd, { scopeKind: 'agent', scopeId: agentId, agent, systemPrompt: prompt });

  const policy = spawnToolPolicy(cmd, {
    id: `tool-policy:agent:${agentId}`,
    name: definition.toolPolicy.name ?? `${definition.name} Tools`,
    allowedTools: definition.toolPolicy.allowedTools,
    toolConfigs: definition.toolPolicy.toolConfigs
  });
  linkToolPolicyToScope(cmd, { scopeKind: 'agent', scopeId: agentId, agent, toolPolicy: policy });

  if (definition.model?.model.trim()) {
    const profile = spawnModelProfile(cmd, {
      id: `model-profile:agent:${agentId}`,
      name: definition.model.name ?? `${definition.name} Model`,
      provider: definition.model.provider,
      model: definition.model.model
    });
    linkModelProfileToScope(cmd, { scopeKind: 'agent', scopeId: agentId, agent, modelProfile: profile });
  }

  return agent;
}

export function spawnModeFromDefinition(cmd: CommandSink, definition: BuiltinModeDefinition): Entity {
  const now = Date.now();
  const mode = cmd.spawn();
  cmd.add(mode, Mode, {
    id: definition.id,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    source: 'builtin',
    icon: 'list-details',
    createdAt: now,
    updatedAt: now
  });

  if (definition.systemPrompt?.trim()) {
    const prompt = spawnSystemPrompt(cmd, {
      id: `system-prompt:mode:${definition.id}`,
      name: `${definition.name} Prompt`,
      text: definition.systemPrompt
    });
    linkSystemPromptToScope(cmd, { scopeKind: 'mode', scopeId: definition.id, mode, systemPrompt: prompt });
  }

  if (definition.toolPolicy) {
    const policy = spawnToolPolicy(cmd, {
      id: `tool-policy:mode:${definition.id}`,
      name: definition.toolPolicy.name ?? `${definition.name} Tools`,
      allowedTools: definition.toolPolicy.allowedTools,
      toolConfigs: definition.toolPolicy.toolConfigs
    });
    linkToolPolicyToScope(cmd, { scopeKind: 'mode', scopeId: definition.id, mode, toolPolicy: policy });
  }

  if (definition.model) {
    const profile = spawnModelProfile(cmd, {
      id: `model-profile:mode:${definition.id}`,
      name: definition.model.name ?? `${definition.name} Model`,
      provider: definition.model.provider,
      model: definition.model.model
    });
    linkModelProfileToScope(cmd, { scopeKind: 'mode', scopeId: definition.id, mode, modelProfile: profile });
  }

  return mode;
}

export function spawnAgentFromBlueprint(cmd: CommandSink, input: SpawnAgentWithConversationInput): SpawnAgentWithConversationResult {
  const agent = spawnAgentProfileFromBlueprint(cmd, input);
  const conversation = spawnConversation(cmd, { id: input.conversationId, title: input.conversationTitle });
  spawnConversationOriginLink(cmd, { conversation, originKind: 'user', sourceKind: 'user' });
  const link = linkAgentToConversation(cmd, { agent, conversation, role: 'default' });
  const selection = selectAgentForConversation(cmd, { agent, conversation, conversationId: input.conversationId, agentId: input.agentId ?? input.definition.id });
  selectGlobalModeForConversation(cmd, conversation, input.conversationId);

  if (input.initialMessage?.trim()) {
    spawnUserMessage(cmd, conversation, input.initialMessage.trim());
  }

  return { agent, conversation, link, selection };
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

export function selectAgentForConversation(
  cmd: CommandSink,
  input: { agent: Entity; conversation: Entity; conversationId: string; agentId: string }
): Entity {
  const now = Date.now();
  const selection = cmd.spawn();
  cmd.add(selection, ConversationAgentSelection, {
    id: `conversation-agent:${input.conversationId}:${input.agentId}`,
    conversation: input.conversation,
    agent: input.agent,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return selection;
}

export function spawnSystemPrompt(cmd: CommandSink, input: { id: string; name: string; text: string }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, SystemPrompt, { id: input.id, name: input.name, text: input.text });
  return entity;
}

export function spawnModelProfile(cmd: CommandSink, input: { id: string; name: string; provider?: string; providerConfigId?: string; model: string }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, ModelProfile, {
    id: input.id,
    name: input.name,
    ...(input.providerConfigId ? { providerConfigId: input.providerConfigId } : {}),
    ...(input.provider ? { provider: input.provider as never } : {}),
    model: input.model
  });
  return entity;
}

export function spawnToolPolicy(cmd: CommandSink, input: { id: string; name: string; allowedTools: string[]; toolConfigs?: Record<string, never> | unknown }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, ToolPolicy, {
    id: input.id,
    name: input.name,
    allowedTools: input.allowedTools,
    ...(input.toolConfigs ? { toolConfigs: input.toolConfigs as never } : {})
  });
  return entity;
}

export function linkSystemPromptToScope(
  cmd: CommandSink,
  input: { scopeKind: ConfigScopeKind; scopeId?: string; systemPrompt: Entity; agent?: Entity; mode?: Entity; conversation?: Entity; run?: Entity; order?: number }
): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, SystemPromptScopeLink, {
    id: `system-prompt-scope:${input.scopeKind}:${input.scopeId ?? 'global'}`,
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    systemPrompt: input.systemPrompt,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    ...(input.run !== undefined ? { run: input.run } : {}),
    role: 'active',
    ...(input.order !== undefined ? { order: input.order } : {}),
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function linkModelProfileToScope(
  cmd: CommandSink,
  input: { scopeKind: ConfigScopeKind; scopeId?: string; modelProfile: Entity; agent?: Entity; mode?: Entity; conversation?: Entity; run?: Entity }
): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, ModelProfileScopeLink, {
    id: `model-profile-scope:${input.scopeKind}:${input.scopeId ?? 'global'}`,
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    modelProfile: input.modelProfile,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    ...(input.run !== undefined ? { run: input.run } : {}),
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function linkToolPolicyToScope(
  cmd: CommandSink,
  input: { scopeKind: ToolPolicyScopeKind; scopeId?: string; toolPolicy: Entity; agent?: Entity; mode?: Entity; conversation?: Entity; run?: Entity }
): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, ToolPolicyScopeLink, {
    id: `tool-policy-scope:${input.scopeKind}:${input.scopeId ?? 'global'}`,
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    toolPolicy: input.toolPolicy,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    ...(input.run !== undefined ? { run: input.run } : {}),
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function hasAgentId(world: WorldReader, id: string): boolean {
  return world.query(Agent).some((entity) => world.get(entity, Agent)?.id === id);
}

export function hasModeId(world: WorldReader, id: string): boolean {
  return world.query(Mode).some((entity) => world.get(entity, Mode)?.id === id);
}
