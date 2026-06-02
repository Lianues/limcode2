import type { Entity, World } from '../ecs/types';
import { Agent, AgentConversationLink, AgentKind, AgentStatus } from '../world/modules/agent/components';
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
} from '../world/modules/mode/components';
import { rememberHydratedMessageSeq, resetMessageSeqState } from '../world/modules/chat/bundles';
import { Conversation, ConversationBranchLink, ConversationReuseLink, Message, MessageCurrentRevisionLink, MessageRevision, PartOf } from '../world/modules/chat/components';
import { ToolCall, ToolCallEvent, ToolResultConsumed, ToolState } from '../world/modules/tools/components';
import { isTerminalToolStatus } from '../world/modules/tools/state';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunApprovalPolicyLink,
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

export function hydrateClientState(world: World, state: ClientState): boolean {
  resetMessageSeqState();

  const hasAnyState = state.agents.length > 0 || state.conversations.length > 0 || state.messages.length > 0 || state.agentModes.length > 0;
  if (!hasAnyState) return false;

  const defaultAgent = createDefaultAgentRecord();
  const agents = state.agents.length > 0 ? state.agents : [defaultAgent];
  const conversations = state.conversations.length > 0 ? state.conversations : [{ id: DEFAULT_CONVERSATION_ID }];

  const agentEntities = new Map<string, Entity>();
  for (const agent of agents) {
    const entity = world.spawn();
    agentEntities.set(agent.id, entity);
    world.add(entity, Agent, { id: agent.id, name: agent.name || DEFAULT_AGENT_NAME });
    world.add(entity, AgentKind, { kind: agent.kind || 'main' });
    world.add(entity, AgentStatus, { status: agent.status ?? 'idle' });
  }

  const modeEntities = new Map<string, Entity>();
  for (const record of state.agentModes) {
    const entity = world.spawn();
    modeEntities.set(record.id, entity);
    world.add(entity, AgentMode, record);
  }

  const toolPolicyEntities = new Map<string, Entity>();
  for (const record of state.toolPolicies) {
    const entity = world.spawn();
    toolPolicyEntities.set(record.id, entity);
    world.add(entity, ToolPolicy, record);
  }

  const approvalPolicyEntities = new Map<string, Entity>();
  for (const record of state.approvalPolicies) {
    const entity = world.spawn();
    approvalPolicyEntities.set(record.id, entity);
    world.add(entity, ApprovalPolicy, record);
  }

  const systemPromptEntities = new Map<string, Entity>();
  for (const record of state.systemPrompts) {
    const entity = world.spawn();
    systemPromptEntities.set(record.id, entity);
    world.add(entity, SystemPrompt, record);
  }

  const modelProfileEntities = new Map<string, Entity>();
  for (const record of state.modelProfiles) {
    const entity = world.spawn();
    modelProfileEntities.set(record.id, entity);
    world.add(entity, ModelProfile, record);
  }

  for (const link of state.agentModeLinks) spawnLink(world, agentEntities, modeEntities, link, AgentModeLink, 'agent', 'mode');
  for (const link of state.modeToolPolicyLinks) spawnLink(world, modeEntities, toolPolicyEntities, link, ModeToolPolicyLink, 'mode', 'toolPolicy');
  for (const link of state.modeApprovalPolicyLinks) spawnLink(world, modeEntities, approvalPolicyEntities, link, ModeApprovalPolicyLink, 'mode', 'approvalPolicy');
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


  for (const link of state.agentConversationLinks) {
    const agent = agentEntities.get(link.agentId);
    const conversation = conversationEntities.get(link.conversationId);
    if (agent === undefined || conversation === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
    world.add(entity, AgentConversationLink, { id: link.id, agent, conversation, role: link.role, createdAt: now, updatedAt: now });
  }

  const messageEntities = new Map<string, Entity>();
  for (const record of state.messages) {
    const conversation = conversationEntities.get(record.conversationId);
    if (conversation === undefined) continue;
    const entity = spawnHydratedMessage(world, conversation, record);
    messageEntities.set(record.id, entity);
  }

  const revisionEntities = new Map<string, Entity>();
  for (const record of state.messageRevisions ?? []) {
    const message = messageEntities.get(record.messageId);
    if (message === undefined) continue;
    const entity = world.spawn();
    revisionEntities.set(record.id, entity);
    world.add(entity, MessageRevision, { id: record.id, content: record.content, createdAt: record.createdAt, reason: record.reason });
    world.add(entity, PartOf, { parent: message });
  }
  for (const record of state.messageCurrentRevisionLinks ?? []) {
    const message = messageEntities.get(record.messageId);
    const revision = revisionEntities.get(record.revisionId);
    if (message === undefined || revision === undefined) continue;
    const entity = world.spawn();
    world.add(entity, MessageCurrentRevisionLink, { id: record.id, message, revision });
  }

  for (const record of state.conversationBranchLinks ?? []) {
    const sourceConversation = conversationEntities.get(record.sourceConversationId);
    const targetConversation = conversationEntities.get(record.targetConversationId);
    if (sourceConversation === undefined || targetConversation === undefined) continue;
    const sourceRevision = record.sourceRevisionId ? revisionEntities.get(record.sourceRevisionId) : undefined;
    const entity = world.spawn();
    const now = Date.now();
    world.add(entity, ConversationBranchLink, { id: record.id, sourceConversation, targetConversation, ...(sourceRevision !== undefined ? { sourceRevision } : {}), kind: record.kind, createdAt: now, updatedAt: now });
  }


  const toolCallEntities = new Map<string, Entity>();
  for (const record of state.toolCalls) {
    const entity = spawnHydratedToolCall(world, messageEntities, record);
    if (entity !== undefined) toolCallEntities.set(record.id, entity);
  }
  for (const record of state.toolCallEvents ?? []) spawnHydratedToolCallEvent(world, toolCallEntities, record);

  const runEntities = new Map<string, Entity>();
  for (const record of state.agentRuns ?? []) {
    const entity = world.spawn();
    runEntities.set(record.id, entity);
    world.add(entity, AgentRun, record);
  }

  const conversationPolicyEntities = hydrateRecords(world, state.runConversationPolicies, RunConversationPolicy);
  const contextPolicyEntities = hydrateRecords(world, state.runContextPolicies, RunContextPolicy);
  const deliveryPolicyEntities = new Map<string, Entity>();
  for (const record of state.runDeliveryPolicies ?? []) {
    const entity = world.spawn();
    deliveryPolicyEntities.set(record.id, entity);
    world.add(entity, RunDeliveryPolicy, { id: record.id, mode: record.mode, includeTranscript: record.includeTranscript, ...(record.targetConversationId ? { targetConversation: conversationEntities.get(record.targetConversationId) } : {}), ...(record.targetToolCallId ? { targetToolCall: toolCallEntities.get(record.targetToolCallId) } : {}) });
  }
  const editPolicyEntities = hydrateRecords(world, state.runEditPolicies, RunEditPolicy);

  for (const link of state.agentRunSourceLinks ?? []) {
    const run = runEntities.get(link.runId);
    if (run === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
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
  for (const link of state.agentRunTargetLinks ?? []) {
    const run = runEntities.get(link.runId);
    const agent = agentEntities.get(link.agentId);
    const conversation = conversationEntities.get(link.conversationId);
    if (run === undefined || agent === undefined || conversation === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
    world.add(entity, AgentRunTargetLink, { id: link.id, run, agent, conversation, role: link.role, createdAt: now, updatedAt: now });
  }

  for (const link of state.messageRunLinks ?? []) spawnRunLink(world, messageEntities, runEntities, link, MessageRunLink, 'message', 'run');
  for (const link of state.toolCallRunLinks ?? []) spawnRunLink(world, toolCallEntities, runEntities, link, ToolCallRunLink, 'toolCall', 'run');
  for (const link of state.runModeLinks ?? []) spawnRunLink(world, runEntities, modeEntities, link, RunModeLink, 'run', 'mode');
  for (const link of state.runSystemPromptLinks ?? []) spawnRunLink(world, runEntities, systemPromptEntities, link, RunSystemPromptLink, 'run', 'systemPrompt');
  for (const link of state.runModelProfileLinks ?? []) spawnRunLink(world, runEntities, modelProfileEntities, link, RunModelProfileLink, 'run', 'modelProfile');
  for (const link of state.runToolPolicyLinks ?? []) spawnRunLink(world, runEntities, toolPolicyEntities, link, RunToolPolicyLink, 'run', 'toolPolicy');
  for (const link of state.runApprovalPolicyLinks ?? []) spawnRunLink(world, runEntities, approvalPolicyEntities, link, RunApprovalPolicyLink, 'run', 'approvalPolicy');
  for (const link of state.runConversationPolicyLinks ?? []) spawnRunLink(world, runEntities, conversationPolicyEntities, link, RunConversationPolicyLink, 'run', 'policy');
  for (const link of state.runContextPolicyLinks ?? []) spawnRunLink(world, runEntities, contextPolicyEntities, link, RunContextPolicyLink, 'run', 'policy');
  for (const link of state.runDeliveryPolicyLinks ?? []) spawnRunLink(world, runEntities, deliveryPolicyEntities, link, RunDeliveryPolicyLink, 'run', 'policy');
  for (const link of state.runEditPolicyLinks ?? []) spawnRunLink(world, runEntities, editPolicyEntities, link, RunEditPolicyLink, 'run', 'policy');

  for (const record of state.agentRunInputRevisions ?? []) {
    const run = runEntities.get(record.runId);
    const conversation = conversationEntities.get(record.conversationId);
    const revision = revisionEntities.get(record.revisionId);
    if (run === undefined || conversation === undefined || revision === undefined) continue;
    const entity = world.spawn();
    world.add(entity, AgentRunInputRevision, { id: record.id, run, conversation, revision });
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
    usageMetadata: record.usageMetadata
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

function spawnLink(world: World, left: Map<string, Entity>, right: Map<string, Entity>, record: any, component: { id: symbol }, leftKey: string, rightKey: string): void {
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
