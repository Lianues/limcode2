import type { Entity, World } from '../ecs/types';
import { Agent, AgentConversationLink, AgentKind, AgentStatus } from '../world/modules/agent/components';
import {
  AgentMode,
  AgentModeLink,
  ModeModelProfileLink,
  ModeSystemPromptLink,
  ModeToolPolicyLink,
  ModelProfile,
  SystemPrompt,
  ToolPolicy
} from '../world/modules/mode/components';
import { rememberHydratedMessageSeq, resetMessageSeqState } from '../world/modules/chat/bundles';
import { Conversation, ConversationBranchLink, ConversationReuseLink, Message, MessageCurrentRevisionLink, MessageRevision, PartOf } from '../world/modules/chat/components';
import { ConversationProjectLink, ProjectContext } from '../world/modules/project/components';
import { ToolCall, ToolCallEvent, ToolPolicyScopeLink, ToolResultConsumed, ToolState } from '../world/modules/tools/components';
import { isTerminalToolStatus } from '../world/modules/tools/state';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunConversationPolicy,
  RunConversationPolicyLink,
  RunDeliveryPolicy,
  RunDeliveryPolicyLink,
  RunEditPolicy,
  RunEditPolicyLink,
  RunModeLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from '../world/modules/agentRun/components';
import type { ClientState, MessageRecord, ToolCallEventRecord, ToolCallRecord } from '../../shared/protocol';
import { createDefaultAgentRecord, DEFAULT_AGENT_NAME, DEFAULT_CONVERSATION_ID } from './defaults';

export function hydrateClientStateSkeleton(world: World, state: ClientState): boolean {
  resetMessageSeqState();

  const hasAnyState = state.agents.length > 0 || state.conversations.length > 0 || state.agentModes.length > 0;
  if (!hasAnyState) return false;

  const defaultAgent = createDefaultAgentRecord();
  const agents = state.agents.length > 0 ? state.agents : [defaultAgent];
  const conversations = state.conversations.length > 0 ? state.conversations : [{ id: DEFAULT_CONVERSATION_ID }];

  const agentEntities = new Map<string, Entity>();
  for (const agent of agents) {
    if (agentEntities.has(agent.id)) continue;
    const entity = world.spawn();
    agentEntities.set(agent.id, entity);
    world.add(entity, Agent, { id: agent.id, name: agent.name || DEFAULT_AGENT_NAME });
    world.add(entity, AgentKind, { kind: agent.kind || 'main' });
    world.add(entity, AgentStatus, { status: agent.status ?? 'idle' });
  }

  const modeEntities = hydrateRecords(world, state.agentModes, AgentMode);
  const toolPolicyEntities = hydrateRecords(world, state.toolPolicies, ToolPolicy);
  const systemPromptEntities = hydrateRecords(world, state.systemPrompts, SystemPrompt);
  const modelProfileEntities = hydrateRecords(world, state.modelProfiles, ModelProfile);

  for (const link of state.agentModeLinks) spawnLink(world, agentEntities, modeEntities, link, AgentModeLink, 'agent', 'mode');
  for (const link of state.modeToolPolicyLinks) spawnLink(world, modeEntities, toolPolicyEntities, link, ModeToolPolicyLink, 'mode', 'toolPolicy');
  for (const link of state.modeSystemPromptLinks) spawnLink(world, modeEntities, systemPromptEntities, link, ModeSystemPromptLink, 'mode', 'systemPrompt');
  for (const link of state.modeModelProfileLinks) spawnLink(world, modeEntities, modelProfileEntities, link, ModeModelProfileLink, 'mode', 'modelProfile');

  const conversationEntities = new Map<string, Entity>();
  for (const conversation of conversations) {
    const entity = world.spawn();
    conversationEntities.set(conversation.id, entity);
    world.add(entity, Conversation, { id: conversation.id, title: conversation.title, visibility: conversation.visibility ?? 'visible' });
  }

  for (const record of state.conversationReuseLinks ?? []) {
    const conversation = conversationEntities.get(record.conversationId);
    if (conversation === undefined) continue;
    const agent = record.agentId ? agentEntities.get(record.agentId) : undefined;
    const entity = world.spawn();
    const now = Date.now();
    world.add(entity, ConversationReuseLink, { id: record.id, key: record.key, conversation, ...(agent !== undefined ? { agent } : {}), createdAt: now, updatedAt: now });
  }

  const projectContextEntities = hydrateRecords(world, state.projectContexts ?? [], ProjectContext);

  for (const link of state.conversationProjectLinks ?? []) {
    const conversation = conversationEntities.get(link.conversationId);
    const projectContext = projectContextEntities.get(link.projectContextId);
    if (conversation === undefined || projectContext === undefined) continue;
    const entity = world.spawn();
    world.add(entity, ConversationProjectLink, {
      id: link.id,
      conversation,
      projectContext,
      role: link.role,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt
    });
  }

  for (const link of state.agentConversationLinks) {
    const agent = agentEntities.get(link.agentId);
    const conversation = conversationEntities.get(link.conversationId);
    if (agent === undefined || conversation === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
    world.add(entity, AgentConversationLink, { id: link.id, agent, conversation, role: link.role, createdAt: now, updatedAt: now });
  }

  for (const record of state.conversationBranchLinks ?? []) {
    const sourceConversation = conversationEntities.get(record.sourceConversationId);
    const targetConversation = conversationEntities.get(record.targetConversationId);
    if (sourceConversation === undefined || targetConversation === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
    world.add(entity, ConversationBranchLink, { id: record.id, sourceConversation, targetConversation, kind: record.kind, createdAt: now, updatedAt: now });
  }

  hydrateToolPolicyScopeLinks(world, state, {
    agents: agentEntities,
    conversations: conversationEntities,
    modes: modeEntities,
    toolPolicies: toolPolicyEntities,
    runs: new Map()
  });

  return true;
}


export function hydrateConversationDetail(world: World, state: ClientState, conversationId: string): boolean {
  const conversationEntities = existingRecords(world, Conversation);
  const conversation = conversationEntities.get(conversationId);
  if (conversation === undefined) return false;

  const agentEntities = existingRecords(world, Agent);
  const modeEntities = existingRecords(world, AgentMode);
  const toolPolicyEntities = existingRecords(world, ToolPolicy);
  const systemPromptEntities = existingRecords(world, SystemPrompt);
  const modelProfileEntities = existingRecords(world, ModelProfile);

  const messageEntities = existingRecords(world, Message);
  for (const record of state.messages.filter((message) => message.conversationId === conversationId)) {
    if (messageEntities.has(record.id)) continue;
    const entity = spawnHydratedMessage(world, conversation, record);
    messageEntities.set(record.id, entity);
  }

  const revisionEntities = existingRecords(world, MessageRevision);
  for (const record of state.messageRevisions ?? []) {
    const message = messageEntities.get(record.messageId);
    if (message === undefined || revisionEntities.has(record.id)) continue;
    const entity = world.spawn();
    revisionEntities.set(record.id, entity);
    world.add(entity, MessageRevision, { id: record.id, content: record.content, createdAt: record.createdAt, reason: record.reason });
    world.add(entity, PartOf, { parent: message });
  }

  const currentRevisionLinkIds = existingIds(world, MessageCurrentRevisionLink);
  for (const record of state.messageCurrentRevisionLinks ?? []) {
    if (currentRevisionLinkIds.has(record.id)) continue;
    const message = messageEntities.get(record.messageId);
    const revision = revisionEntities.get(record.revisionId);
    if (message === undefined || revision === undefined) continue;
    const entity = world.spawn();
    currentRevisionLinkIds.add(record.id);
    world.add(entity, MessageCurrentRevisionLink, { id: record.id, message, revision });
  }

  const toolCallEntities = existingRecords(world, ToolCall);
  for (const record of state.toolCalls) {
    if (toolCallEntities.has(record.id)) continue;
    const entity = spawnHydratedToolCall(world, messageEntities, record);
    if (entity !== undefined) toolCallEntities.set(record.id, entity);
  }

  const toolCallEventIds = existingIds(world, ToolCallEvent);
  for (const record of state.toolCallEvents ?? []) {
    if (toolCallEventIds.has(record.id)) continue;
    spawnHydratedToolCallEvent(world, toolCallEntities, record);
    toolCallEventIds.add(record.id);
  }

  const runEntities = hydrateRecordsUnique(world, state.agentRuns ?? [], AgentRun);
  const conversationPolicyEntities = hydrateRecordsUnique(world, state.runConversationPolicies, RunConversationPolicy);
  const contextPolicyEntities = hydrateRecordsUnique(world, state.runContextPolicies, RunContextPolicy);
  const deliveryPolicyEntities = existingRecords(world, RunDeliveryPolicy);
  for (const record of state.runDeliveryPolicies ?? []) {
    if (deliveryPolicyEntities.has(record.id)) continue;
    const entity = world.spawn();
    deliveryPolicyEntities.set(record.id, entity);
    world.add(entity, RunDeliveryPolicy, {
      id: record.id,
      mode: record.mode,
      includeTranscript: record.includeTranscript,
      ...(record.targetConversationId ? { targetConversation: conversationEntities.get(record.targetConversationId) } : {}),
      ...(record.targetToolCallId ? { targetToolCall: toolCallEntities.get(record.targetToolCallId) } : {})
    });
  }
  const editPolicyEntities = hydrateRecordsUnique(world, state.runEditPolicies, RunEditPolicy);

  const sourceLinkIds = existingIds(world, AgentRunSourceLink);
  for (const link of state.agentRunSourceLinks ?? []) {
    if (sourceLinkIds.has(link.id)) continue;
    const run = runEntities.get(link.runId);
    if (run === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
    sourceLinkIds.add(link.id);
    world.add(entity, AgentRunSourceLink, {
      id: link.id,
      run,
      sourceKind: link.sourceKind,
      ...(link.sourceAgentId ? { sourceAgent: agentEntities.get(link.sourceAgentId) } : {}),
      ...(link.sourceConversationId ? { sourceConversation: conversationEntities.get(link.sourceConversationId) } : {}),
      ...(link.sourceMessageId ? { sourceMessage: messageEntities.get(link.sourceMessageId) } : {}),
      ...(link.sourceToolCallId ? { sourceToolCall: toolCallEntities.get(link.sourceToolCallId) } : {}),
      ...(link.sourceRunId ? { sourceRun: runEntities.get(link.sourceRunId) } : {}),
      createdAt: now,
      updatedAt: now
    });
  }

  const targetLinkIds = existingIds(world, AgentRunTargetLink);
  for (const link of state.agentRunTargetLinks ?? []) {
    if (targetLinkIds.has(link.id)) continue;
    const run = runEntities.get(link.runId);
    const agent = agentEntities.get(link.agentId);
    const targetConversation = conversationEntities.get(link.conversationId);
    if (run === undefined || agent === undefined || targetConversation === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
    targetLinkIds.add(link.id);
    world.add(entity, AgentRunTargetLink, { id: link.id, run, agent, conversation: targetConversation, role: link.role, createdAt: now, updatedAt: now });
  }

  for (const link of state.messageRunLinks ?? []) spawnRunLink(world, messageEntities, runEntities, link, MessageRunLink, 'message', 'run');
  for (const link of state.toolCallRunLinks ?? []) spawnRunLink(world, toolCallEntities, runEntities, link, ToolCallRunLink, 'toolCall', 'run');
  for (const link of state.runModeLinks ?? []) spawnRunLink(world, runEntities, modeEntities, link, RunModeLink, 'run', 'mode');
  for (const link of state.runSystemPromptLinks ?? []) spawnRunLink(world, runEntities, systemPromptEntities, link, RunSystemPromptLink, 'run', 'systemPrompt');
  for (const link of state.runModelProfileLinks ?? []) spawnRunLink(world, runEntities, modelProfileEntities, link, RunModelProfileLink, 'run', 'modelProfile');
  for (const link of state.runToolPolicyLinks ?? []) spawnRunLink(world, runEntities, toolPolicyEntities, link, RunToolPolicyLink, 'run', 'toolPolicy');
  for (const link of state.runConversationPolicyLinks ?? []) spawnRunLink(world, runEntities, conversationPolicyEntities, link, RunConversationPolicyLink, 'run', 'policy');
  for (const link of state.runContextPolicyLinks ?? []) spawnRunLink(world, runEntities, contextPolicyEntities, link, RunContextPolicyLink, 'run', 'policy');
  for (const link of state.runDeliveryPolicyLinks ?? []) spawnRunLink(world, runEntities, deliveryPolicyEntities, link, RunDeliveryPolicyLink, 'run', 'policy');
  for (const link of state.runEditPolicyLinks ?? []) spawnRunLink(world, runEntities, editPolicyEntities, link, RunEditPolicyLink, 'run', 'policy');


  hydrateToolPolicyScopeLinks(world, state, {
    agents: agentEntities,
    conversations: conversationEntities,
    modes: modeEntities,
    toolPolicies: toolPolicyEntities,
    runs: runEntities
  });

  const inputRevisionIds = existingIds(world, AgentRunInputRevision);
  for (const record of state.agentRunInputRevisions ?? []) {
    if (inputRevisionIds.has(record.id)) continue;
    const run = runEntities.get(record.runId);
    const inputConversation = conversationEntities.get(record.conversationId);
    const revision = revisionEntities.get(record.revisionId);
    if (run === undefined || inputConversation === undefined || revision === undefined) continue;
    const entity = world.spawn();
    inputRevisionIds.add(record.id);
    world.add(entity, AgentRunInputRevision, { id: record.id, run, conversation: inputConversation, revision });
  }

  return true;
}

function spawnHydratedMessage(world: World, conversation: Entity, record: MessageRecord): Entity {
  const entity = world.spawn();
  world.add(entity, Message, {
    id: record.id,
    role: record.role,
    content: record.content,
    status: record.status === 'streaming' ? 'error' : record.status,
    seq: record.seq,
    createdAt: record.createdAt,
    streamOutputDurationMs: record.streamOutputDurationMs,
    usageMetadata: record.usageMetadata,
    stopReason: record.stopReason
  });
  rememberHydratedMessageSeq(conversation, record.seq);
  world.add(entity, PartOf, { parent: conversation });
  return entity;
}

function spawnHydratedToolCall(world: World, messages: Map<string, Entity>, record: ToolCallRecord): Entity | undefined {
  const modelMessage = messages.get(record.messageId);
  if (modelMessage === undefined) return undefined;

  const entity = world.spawn();
  const now = Date.now();
  const interrupted = !isTerminalToolStatus(record.status);
  const status = interrupted ? 'error' : record.status;
  const error = interrupted ? record.error ?? '工具执行因扩展重启中断。' : record.error;

  world.add(entity, ToolCall, { id: record.id, name: record.name, functionCallId: record.functionCallId, argsJson: record.args, createdAt: record.createdAt });
  world.add(entity, PartOf, { parent: modelMessage });
  world.add(entity, ToolState, {
    status,
    updatedAt: record.updatedAt || now,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(record.progress !== undefined ? { progress: record.progress } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {})
  });
  world.add(entity, ToolResultConsumed, true);
  return entity;
}

function spawnHydratedToolCallEvent(world: World, toolCalls: Map<string, Entity>, record: ToolCallEventRecord): void {
  const toolCall = toolCalls.get(record.toolCallId);
  if (toolCall === undefined) return;
  const entity = world.spawn();
  world.add(entity, ToolCallEvent, record);
  world.add(entity, PartOf, { parent: toolCall });
}

function hydrateRecords<T extends { id: string }>(world: World, records: T[] | undefined, component: { id: symbol }): Map<string, Entity> {
  const entities = new Map<string, Entity>();
  for (const record of records ?? []) {
    const entity = world.spawn();
    entities.set(record.id, entity);
    world.add(entity, component as never, record as never);
  }
  return entities;
}

function hydrateRecordsUnique<T extends { id: string }>(world: World, records: T[] | undefined, component: { id: symbol }): Map<string, Entity> {
  const entities = existingRecords<T>(world, component);
  for (const record of records ?? []) {
    if (entities.has(record.id)) continue;
    const entity = world.spawn();
    entities.set(record.id, entity);
    world.add(entity, component as never, record as never);
  }
  return entities;
}

function existingRecords<T extends { id: string }>(world: World, component: { id: symbol }): Map<string, Entity> {
  const entities = new Map<string, Entity>();
  for (const entity of world.query(component as never)) {
    const record = world.get(entity, component as never) as T | undefined;
    if (record?.id) entities.set(record.id, entity);
  }
  return entities;
}

function existingIds<T extends { id: string }>(world: World, component: { id: symbol }): Set<string> {
  return new Set([...existingRecords<T>(world, component).keys()]);
}

interface ToolPolicyScopeHydrationMaps {
  agents: Map<string, Entity>;
  conversations: Map<string, Entity>;
  modes: Map<string, Entity>;
  toolPolicies: Map<string, Entity>;
  runs: Map<string, Entity>;
}

function hydrateToolPolicyScopeLinks(world: World, state: ClientState, maps: ToolPolicyScopeHydrationMaps): void {
  const existing = existingIds(world, ToolPolicyScopeLink);
  for (const record of state.toolPolicyScopeLinks ?? []) {
    if (existing.has(record.id)) continue;
    const toolPolicy = maps.toolPolicies.get(record.toolPolicyId);
    if (toolPolicy === undefined) continue;
    const scope = resolveHydratedToolPolicyScope(record.scopeKind, record.scopeId, maps);
    if (!scope.ok) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, ToolPolicyScopeLink, {
      id: record.id,
      scopeKind: record.scopeKind,
      ...(record.scopeId ? { scopeId: record.scopeId } : {}),
      toolPolicy,
      ...scope.data,
      role: record.role,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

function resolveHydratedToolPolicyScope(
  scopeKind: NonNullable<ClientState['toolPolicyScopeLinks'][number]>['scopeKind'],
  scopeId: string | undefined,
  maps: ToolPolicyScopeHydrationMaps
): { ok: true; data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity; agentSystemId: string }> } | { ok: false } {
  switch (scopeKind) {
    case 'global':
      return { ok: true, data: {} };
    case 'conversation': {
      const conversation = scopeId ? maps.conversations.get(scopeId) : undefined;
      return conversation === undefined ? { ok: false } : { ok: true, data: { conversation } };
    }
    case 'agent': {
      const agent = scopeId ? maps.agents.get(scopeId) : undefined;
      return agent === undefined ? { ok: false } : { ok: true, data: { agent } };
    }
    case 'mode': {
      const mode = scopeId ? maps.modes.get(scopeId) : undefined;
      return mode === undefined ? { ok: false } : { ok: true, data: { mode } };
    }
    case 'run': {
      const run = scopeId ? maps.runs.get(scopeId) : undefined;
      return run === undefined ? { ok: false } : { ok: true, data: { run } };
    }
    case 'agentSystem':
      return scopeId ? { ok: true, data: { agentSystemId: scopeId } } : { ok: false };
  }
}


function spawnLink(world: World, left: Map<string, Entity>, right: Map<string, Entity>, record: any, component: { id: symbol }, leftKey: string, rightKey: string): void {
  if (existingIds(world, component).has(record.id)) return;
  const leftId = record[`${leftKey}Id`] as string | undefined;
  const rightId = record[`${rightKey}Id`] as string | undefined;
  if (!leftId || !rightId) return;
  const leftEntity = left.get(leftId);
  const rightEntity = right.get(rightId);
  if (leftEntity === undefined || rightEntity === undefined) return;
  const now = Date.now();
  const entity = world.spawn();
  world.add(entity, component as never, { id: record.id, [leftKey]: leftEntity, [rightKey]: rightEntity, role: record.role, createdAt: now, updatedAt: now } as never);
}

function spawnRunLink(world: World, left: Map<string, Entity>, right: Map<string, Entity>, record: any, component: { id: symbol }, leftKey: string, rightKey: string): void {
  if (existingIds(world, component).has(record.id)) return;
  const leftId = record[`${leftKey}Id`] as string | undefined;
  const rightId = record[`${rightKey}Id`] as string | undefined;
  if (!leftId || !rightId) return;
  const leftEntity = left.get(leftId);
  const rightEntity = right.get(rightId);
  if (leftEntity === undefined || rightEntity === undefined) return;
  const now = Date.now();
  const entity = world.spawn();
  world.add(entity, component as never, { id: record.id, [leftKey]: leftEntity, [rightKey]: rightEntity, role: record.role, createdAt: now, updatedAt: now } as never);
}
