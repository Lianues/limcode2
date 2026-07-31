import { defineBundle, type CommandSink, type Entity, type WorldReader } from '../../../ecs/types';
import { createStableId } from '../../../utils/stableId';
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
  ConversationWorkflowSelection,
  Workflow,
  ModelProfile,
  ModelProfileScopeLink,
  SystemPrompt,
  SystemPromptScopeLink,
  ToolPolicy
} from '../workflow/components';
import { selectDefaultWorkflowForConversation } from '../workflow/bundles';
import { ToolPolicyScopeLink } from '../tools/components';
import { PlanReviewPolicy, PlanReviewPolicyScopeLink } from '../plan/components';
import { normalizePlanReviewPolicy } from '../plan/bundles';
import type { BuiltinAgentDefinition, BuiltinWorkflowDefinition } from './blueprints';
import type { AgentSource, ConfigScopeKind, ToolPolicyScopeKind } from '../../../../shared/protocol';

export const AgentFromBlueprintBundle = defineBundle({
  name: 'AgentFromBlueprintBundle',
  writes: [
    Agent,
    AgentKind,
    AgentStatus,
    Workflow,
    ToolPolicy,
    SystemPrompt,
    SystemPromptScopeLink,
    ModelProfile,
    ModelProfileScopeLink,
    ToolPolicyScopeLink,
    PlanReviewPolicy,
    PlanReviewPolicyScopeLink,
    Conversation,
    ConversationOriginLink,
    ConversationWorkflowSelection,
    AgentConversationLink,
    ConversationAgentSelection,
    Message,
    PartOf
  ],
  mutationMode: 'create',
  spawns: true,
  despawns: true
});

export const ConversationAgentBindingBundle = defineBundle({
  name: 'ConversationAgentBindingBundle',
  writes: [AgentConversationLink, ConversationAgentSelection],
  mutationMode: 'create',
  spawns: true
});

export interface SpawnAgentProfileInput {
  definition: BuiltinAgentDefinition;
  agentId?: string;
  agentName?: string;
  source?: AgentSource;
}

export interface SpawnAgentRuntimeMirrorInput {
  mirrorAgentId: string;
  typeAgentId: string;
  name: string;
  description?: string;
  source?: AgentSource;
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

export function spawnAgentRuntimeMirror(cmd: CommandSink, input: SpawnAgentRuntimeMirrorInput): Entity {
  const agent = cmd.spawn();
  cmd.add(agent, Agent, {
    id: input.mirrorAgentId,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    source: input.source ?? 'builtin'
  });
  cmd.add(agent, AgentKind, { kind: input.typeAgentId });
  cmd.add(agent, AgentStatus, { status: 'idle' });
  return agent;
}

export function spawnWorkflowFromDefinition(cmd: CommandSink, definition: BuiltinWorkflowDefinition): Entity {
  const now = Date.now();
  const workflow = cmd.spawn();
  cmd.add(workflow, Workflow, {
    id: definition.id,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    source: 'builtin',
    icon: definition.icon ?? 'list-details',
    createdAt: now,
    updatedAt: now
  });

  if (definition.systemPrompt?.trim()) {
    const prompt = spawnSystemPrompt(cmd, {
      id: `system-prompt:workflow:${definition.id}`,
      name: `${definition.name} Prompt`,
      text: definition.systemPrompt
    });
    linkSystemPromptToScope(cmd, { scopeKind: 'workflow', scopeId: definition.id, workflow, systemPrompt: prompt });
  }

  if (definition.toolPolicy) {
    const policy = spawnToolPolicy(cmd, {
      id: `tool-policy:workflow:${definition.id}`,
      name: definition.toolPolicy.name ?? `${definition.name} Tools`,
      allowedTools: definition.toolPolicy.allowedTools,
      toolConfigs: definition.toolPolicy.toolConfigs
    });
    linkToolPolicyToScope(cmd, { scopeKind: 'workflow', scopeId: definition.id, workflow, toolPolicy: policy });
  }

  if (definition.model) {
    const profile = spawnModelProfile(cmd, {
      id: `model-profile:workflow:${definition.id}`,
      name: definition.model.name ?? `${definition.name} Model`,
      provider: definition.model.provider,
      model: definition.model.model
    });
    linkModelProfileToScope(cmd, { scopeKind: 'workflow', scopeId: definition.id, workflow, modelProfile: profile });
  }

  if (definition.planReviewPolicy) {
    const policy = spawnPlanReviewPolicy(cmd, {
      id: definition.planReviewPolicy.id ?? `plan-review-policy:workflow:${definition.id}`,
      ...definition.planReviewPolicy
    });
    linkPlanReviewPolicyToWorkflow(cmd, {
      scopeId: definition.id,
      workflow,
      planReviewPolicy: policy
    });
  }

  return workflow;
}

export function spawnAgentFromBlueprint(cmd: CommandSink, input: SpawnAgentWithConversationInput): SpawnAgentWithConversationResult {
  const agent = spawnAgentProfileFromBlueprint(cmd, input);
  return spawnConversationForAgent(cmd, {
    agent,
    agentId: input.agentId ?? input.definition.id,
    conversationId: input.conversationId,
    conversationTitle: input.conversationTitle,
    initialMessage: input.initialMessage
  });
}

export function spawnConversationForAgent(
  cmd: CommandSink,
  input: {
    agent: Entity;
    agentId: string;
    conversationId: string;
    initialMessage?: string;
    conversationTitle?: string;
  }
): SpawnAgentWithConversationResult {
  const conversation = spawnConversation(cmd, { id: input.conversationId, title: input.conversationTitle });
  spawnConversationOriginLink(cmd, { conversation, originKind: 'user', sourceKind: 'user' });
  const link = linkAgentToConversation(cmd, { agent: input.agent, conversation, role: 'default' });
  const selection = selectAgentForConversation(cmd, {
    agent: input.agent,
    conversation,
    conversationId: input.conversationId,
    agentId: input.agentId
  });
  selectDefaultWorkflowForConversation(cmd, conversation, input.conversationId);

  if (input.initialMessage?.trim()) {
    spawnUserMessage(cmd, conversation, input.initialMessage.trim());
  }

  return { agent: input.agent, conversation, link, selection };
}

export function linkAgentToConversation(
  cmd: CommandSink,
  input: { agent: Entity; conversation: Entity; role?: 'default' | 'participant' | 'reviewer' }
): Entity {
  const link = cmd.spawn();
  const now = Date.now();
  cmd.add(link, AgentConversationLink, {
    id: createStableId('acl'),
    agent: input.agent,
    conversation: input.conversation,
    role: input.role ?? 'participant',
    createdAt: now,
    updatedAt: now
  });
  return link;
}

export interface SelectAgentForConversationInput {
  agent: Entity;
  conversation: Entity;
  conversationId: string;
  agentId: string;
}

interface PendingConversationAgentSelection {
  entity: Entity;
  createdAt: number;
}

/**
 * CommandBuffer 的写入在 wave 边界才可见。同一 system pass 内多次 ensure 时，
 * 仅查询 world 仍会重复 spawn，因此按当前 CommandSink 记录待提交的 active relation。
 */
const pendingConversationAgentSelections = new WeakMap<CommandSink, Map<string, PendingConversationAgentSelection>>();

export function conversationAgentSelectionId(conversationId: string, agentId: string): string {
  return `conversation-agent:${conversationId}:${agentId}`;
}

/** 仅用于同时创建新 conversation 的 bundle；已有 conversation 应调用 ensureConversationAgentSelection。 */
export function selectAgentForConversation(
  cmd: CommandSink,
  input: SelectAgentForConversationInput
): Entity {
  const now = Date.now();
  const selection = cmd.spawn();
  cmd.add(selection, ConversationAgentSelection, {
    id: conversationAgentSelectionId(input.conversationId, input.agentId),
    conversation: input.conversation,
    agent: input.agent,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return selection;
}

/**
 * 确保一个 conversation 只有一条 active Agent selection。
 *
 * - 复用已有 relation entity，而不是用相同稳定 id 再 spawn 一个 entity；
 * - 清理历史运行时已经产生的同 conversation 重复项；
 * - 同一 CommandBuffer 中的重复调用复用待提交 entity，避免延迟写入可见性竞态。
 */
export function ensureConversationAgentSelection(
  world: WorldReader,
  cmd: CommandSink,
  input: SelectAgentForConversationInput
): Entity {
  const relationKey = `active:${input.conversationId}`;
  let pendingByRelation = pendingConversationAgentSelections.get(cmd);
  if (!pendingByRelation) {
    pendingByRelation = new Map();
    pendingConversationAgentSelections.set(cmd, pendingByRelation);
  }

  const now = Date.now();
  const id = conversationAgentSelectionId(input.conversationId, input.agentId);
  const pending = pendingByRelation.get(relationKey);
  if (pending) {
    cmd.add(pending.entity, ConversationAgentSelection, {
      id,
      conversation: input.conversation,
      agent: input.agent,
      role: 'active',
      createdAt: pending.createdAt,
      updatedAt: now
    });
    return pending.entity;
  }

  const candidates = world.query(ConversationAgentSelection)
    .map((entity) => ({ entity, data: world.get(entity, ConversationAgentSelection) }))
    .filter((candidate): candidate is { entity: Entity; data: NonNullable<typeof candidate.data> } => {
      if (!candidate.data || candidate.data.role !== 'active') return false;
      const candidateConversationId = world.get(candidate.data.conversation, Conversation)?.id;
      return candidate.data.conversation === input.conversation
        || candidateConversationId === input.conversationId
        || candidate.data.id === id;
    })
    .sort((left, right) => {
      const leftExact = left.data.id === id ? 1 : 0;
      const rightExact = right.data.id === id ? 1 : 0;
      return rightExact - leftExact
        || left.data.createdAt - right.data.createdAt
        || left.entity - right.entity;
    });

  const selected = candidates[0];
  const entity = selected?.entity ?? cmd.spawn();
  const createdAt = selected?.data.createdAt ?? now;
  pendingByRelation.set(relationKey, { entity, createdAt });

  for (const duplicate of candidates.slice(1)) cmd.despawn(duplicate.entity);
  cmd.add(entity, ConversationAgentSelection, {
    id,
    conversation: input.conversation,
    agent: input.agent,
    role: 'active',
    createdAt,
    updatedAt: now
  });
  return entity;
}

/**
 * visible Conversation 的持久 Agent 绑定不变量：优先保留已有 active selection，
 * 其次沿用已有 default/participant Link；两者都缺失时才绑定内置 main Agent。
 * 该函数只补缺失事实，不覆盖用户已经选择的 Agent。
 */
export function ensureVisibleConversationAgentBinding(
  world: WorldReader,
  sink: Pick<CommandSink, 'spawn' | 'add'>,
  input: { conversation: Entity; defaultAgent: Entity }
): boolean {
  const conversation = world.get(input.conversation, Conversation);
  if (!conversation || (conversation.visibility ?? 'visible') !== 'visible') return false;

  const selections = world.query(ConversationAgentSelection)
    .map((entity) => ({ entity, data: world.get(entity, ConversationAgentSelection) }))
    .filter((candidate): candidate is { entity: Entity; data: NonNullable<typeof candidate.data> } =>
      !!candidate.data
      && candidate.data.role === 'active'
      && candidate.data.conversation === input.conversation
      && !!world.get(candidate.data.agent, Agent)
    )
    .sort((left, right) =>
      right.data.updatedAt - left.data.updatedAt
      || right.data.createdAt - left.data.createdAt
      || right.entity - left.entity
    );
  const links = world.query(AgentConversationLink)
    .map((entity) => ({ entity, data: world.get(entity, AgentConversationLink) }))
    .filter((candidate): candidate is { entity: Entity; data: NonNullable<typeof candidate.data> } =>
      !!candidate.data
      && candidate.data.conversation === input.conversation
      && !!world.get(candidate.data.agent, Agent)
    );

  const selectedAgent = selections[0]?.data.agent
    ?? links.find((candidate) => candidate.data.role === 'default')?.data.agent
    ?? links[0]?.data.agent
    ?? input.defaultAgent;
  const selectedAgentId = world.get(selectedAgent, Agent)?.id;
  if (!selectedAgentId) return false;

  const now = Date.now();
  let changed = false;
  if (!links.some((candidate) => candidate.data.agent === selectedAgent)) {
    const link = sink.spawn();
    sink.add(link, AgentConversationLink, {
      id: createStableId('acl'),
      agent: selectedAgent,
      conversation: input.conversation,
      role: 'default',
      createdAt: now,
      updatedAt: now
    });
    changed = true;
  }
  if (selections.length === 0) {
    const selection = sink.spawn();
    sink.add(selection, ConversationAgentSelection, {
      id: conversationAgentSelectionId(conversation.id, selectedAgentId),
      conversation: input.conversation,
      agent: selectedAgent,
      role: 'active',
      createdAt: now,
      updatedAt: now
    });
    changed = true;
  }
  return changed;
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

export function spawnPlanReviewPolicy(cmd: CommandSink, input: Parameters<typeof normalizePlanReviewPolicy>[0]): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, PlanReviewPolicy, normalizePlanReviewPolicy(input));
  return entity;
}

export function linkPlanReviewPolicyToWorkflow(
  cmd: CommandSink,
  input: { scopeId: string; workflow: Entity; planReviewPolicy: Entity }
): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, PlanReviewPolicyScopeLink, {
    id: `plan-review-policy-scope:workflow:${input.scopeId}`,
    scopeKind: 'workflow',
    scopeId: input.scopeId,
    workflow: input.workflow,
    planReviewPolicy: input.planReviewPolicy,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function linkSystemPromptToScope(
  cmd: CommandSink,
  input: { scopeKind: ConfigScopeKind; scopeId?: string; systemPrompt: Entity; agent?: Entity; workflow?: Entity; conversation?: Entity; run?: Entity; order?: number }
): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, SystemPromptScopeLink, {
    id: `system-prompt-scope:${input.scopeKind}:${input.scopeId ?? 'global'}`,
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    systemPrompt: input.systemPrompt,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
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
  input: { scopeKind: ConfigScopeKind; scopeId?: string; modelProfile: Entity; agent?: Entity; workflow?: Entity; conversation?: Entity; run?: Entity }
): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, ModelProfileScopeLink, {
    id: `model-profile-scope:${input.scopeKind}:${input.scopeId ?? 'global'}`,
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    modelProfile: input.modelProfile,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
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
  input: { scopeKind: ToolPolicyScopeKind; scopeId?: string; toolPolicy: Entity; agent?: Entity; workflow?: Entity; conversation?: Entity; run?: Entity }
): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, ToolPolicyScopeLink, {
    id: `tool-policy-scope:${input.scopeKind}:${input.scopeId ?? 'global'}`,
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    toolPolicy: input.toolPolicy,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
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

export function hasWorkflowId(world: WorldReader, id: string): boolean {
  return world.query(Workflow).some((entity) => world.get(entity, Workflow)?.id === id);
}
