import type { Entity, World } from '../ecs/types';
import {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus,
  ParentAgent
} from '../world/modules/agent/components';
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
import { Message, PartOf, Session } from '../world/modules/chat/components';
import { ToolCall, ToolCallEvent, ToolResultConsumed, ToolState } from '../world/modules/tools/components';
import { isTerminalToolStatus } from '../world/modules/tools/state';
import type {
  AgentConversationLinkRecord,
  AgentModeLinkRecord,
  ClientState,
  MessageRecord,
  ModeModelProfileLinkRecord,
  ModeSystemPromptLinkRecord,
  ModeToolPolicyLinkRecord,
  ToolCallEventRecord,
  ToolCallRecord
} from '../../shared/protocol';
import { createDefaultAgentRecord, DEFAULT_AGENT_NAME, DEFAULT_SESSION_ID } from './defaults';

/**
 * 把持久化 ClientState 投影恢复成 ECS 实体/组件。
 * 这里只做数据形态转换，不负责读取文件，也不负责调度系统。
 */
export function hydrateClientState(world: World, state: ClientState): boolean {
  const hasAnyState = state.agents.length > 0 || state.sessions.length > 0 || state.messages.length > 0 || state.agentModes.length > 0;
  if (!hasAnyState) return false;

  const defaultAgent = createDefaultAgentRecord();
  const agents = state.agents.length > 0 ? state.agents : [defaultAgent];
  const sessions = state.sessions.length > 0
    ? state.sessions
    : [{ id: DEFAULT_SESSION_ID }];

  const agentEntities = new Map<string, Entity>();
  for (const agent of agents) {
    const entity = world.spawn();
    agentEntities.set(agent.id, entity);
    world.add(entity, Agent, { id: agent.id, name: agent.name || DEFAULT_AGENT_NAME });
    world.add(entity, AgentKind, { kind: agent.kind || 'main' });
    world.add(entity, AgentStatus, { status: agent.status ?? 'idle' });
  }

  for (const agent of agents) {
    if (!agent.parentAgentId) continue;
    const entity = agentEntities.get(agent.id);
    const parent = agentEntities.get(agent.parentAgentId);
    if (entity !== undefined && parent !== undefined) {
      world.add(entity, ParentAgent, { parent });
    }
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

  for (const link of state.agentModeLinks) {
    spawnHydratedAgentModeLink(world, agentEntities, modeEntities, link);
  }
  for (const link of state.modeToolPolicyLinks) {
    spawnHydratedModeToolPolicyLink(world, modeEntities, toolPolicyEntities, link);
  }
  for (const link of state.modeSystemPromptLinks) {
    spawnHydratedModeSystemPromptLink(world, modeEntities, systemPromptEntities, link);
  }
  for (const link of state.modeModelProfileLinks) {
    spawnHydratedModeModelProfileLink(world, modeEntities, modelProfileEntities, link);
  }

  const sessionEntities = new Map<string, Entity>();
  for (const session of sessions) {
    const entity = world.spawn();
    sessionEntities.set(session.id, entity);
    world.add(entity, Session, { id: session.id, title: session.title });
  }

  for (const link of state.agentConversationLinks) {
    spawnHydratedAgentConversationLink(world, agentEntities, sessionEntities, link);
  }

  const messageEntities = new Map<string, Entity>();
  for (const record of state.messages) {
    const sessionEntity = sessionEntities.get(record.sessionId);
    if (sessionEntity === undefined) continue;
    const entity = spawnHydratedMessage(world, sessionEntity, record);
    messageEntities.set(record.id, entity);
  }

  const toolCallEntities = new Map<string, Entity>();
  for (const record of state.toolCalls) {
    const entity = spawnHydratedToolCall(world, messageEntities, record);
    if (entity !== undefined) toolCallEntities.set(record.id, entity);
  }

  for (const record of state.toolCallEvents ?? []) {
    spawnHydratedToolCallEvent(world, toolCallEntities, record);
  }

  return true;
}

function spawnHydratedMessage(world: World, session: Entity, record: MessageRecord): Entity {
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
  world.add(entity, PartOf, { parent: session });
  return entity;
}

function spawnHydratedToolCall(world: World, messages: Map<string, Entity>, record: ToolCallRecord): Entity | undefined {
  const modelMessage = messages.get(record.messageId);
  if (modelMessage === undefined) return undefined;

  const entity = world.spawn();
  const now = Date.now();
  const interrupted = !isTerminalToolStatus(record.status);
  const status = interrupted ? 'error' : record.status;
  const error = interrupted
    ? record.error ?? '工具执行因扩展重启中断。'
    : record.error;

  world.add(entity, ToolCall, {
    id: record.id,
    name: record.name,
    functionCallId: record.functionCallId,
    argsJson: record.args,
    createdAt: record.createdAt
  });
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

function spawnHydratedAgentConversationLink(
  world: World,
  agents: Map<string, Entity>,
  sessions: Map<string, Entity>,
  record: AgentConversationLinkRecord
): void {
  const agent = agents.get(record.agentId);
  const conversation = sessions.get(record.sessionId);
  if (agent === undefined || conversation === undefined) return;

  const entity = world.spawn();
  const now = Date.now();
  world.add(entity, AgentConversationLink, {
    id: record.id,
    agent,
    conversation,
    role: record.role,
    createdAt: now,
    updatedAt: now
  });
}

function spawnHydratedAgentModeLink(
  world: World,
  agents: Map<string, Entity>,
  modes: Map<string, Entity>,
  record: AgentModeLinkRecord
): void {
  const agent = agents.get(record.agentId);
  const mode = modes.get(record.modeId);
  if (agent === undefined || mode === undefined) return;
  const now = Date.now();
  const entity = world.spawn();
  world.add(entity, AgentModeLink, { id: record.id, agent, mode, role: record.role, createdAt: now, updatedAt: now });
}

function spawnHydratedModeToolPolicyLink(
  world: World,
  modes: Map<string, Entity>,
  toolPolicies: Map<string, Entity>,
  record: ModeToolPolicyLinkRecord
): void {
  const mode = modes.get(record.modeId);
  const toolPolicy = toolPolicies.get(record.toolPolicyId);
  if (mode === undefined || toolPolicy === undefined) return;
  const now = Date.now();
  const entity = world.spawn();
  world.add(entity, ModeToolPolicyLink, { id: record.id, mode, toolPolicy, role: record.role, createdAt: now, updatedAt: now });
}

function spawnHydratedModeSystemPromptLink(
  world: World,
  modes: Map<string, Entity>,
  systemPrompts: Map<string, Entity>,
  record: ModeSystemPromptLinkRecord
): void {
  const mode = modes.get(record.modeId);
  const systemPrompt = systemPrompts.get(record.systemPromptId);
  if (mode === undefined || systemPrompt === undefined) return;
  const now = Date.now();
  const entity = world.spawn();
  world.add(entity, ModeSystemPromptLink, { id: record.id, mode, systemPrompt, role: record.role, createdAt: now, updatedAt: now });
}

function spawnHydratedModeModelProfileLink(
  world: World,
  modes: Map<string, Entity>,
  modelProfiles: Map<string, Entity>,
  record: ModeModelProfileLinkRecord
): void {
  const mode = modes.get(record.modeId);
  const modelProfile = modelProfiles.get(record.modelProfileId);
  if (mode === undefined || modelProfile === undefined) return;
  const now = Date.now();
  const entity = world.spawn();
  world.add(entity, ModeModelProfileLink, { id: record.id, mode, modelProfile, role: record.role, createdAt: now, updatedAt: now });
}
