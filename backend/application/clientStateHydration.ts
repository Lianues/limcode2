import type { Entity, World } from '../ecs/types';
import {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus,
  ModelProfile,
  ParentAgent,
  SystemPrompt,
  ToolPolicy,
  type ModelProfileData,
  type ToolPolicyData
} from '../world/modules/agent/components';
import { Message, PartOf, Session } from '../world/modules/chat/components';
import { ToolCall, ToolCallEvent, ToolResultConsumed, ToolState } from '../world/modules/tools/components';
import { isTerminalToolStatus } from '../world/modules/tools/state';
import type {
  AgentConversationLinkRecord,
  AgentRecord,
  ClientState,
  MessageRecord,
  ToolCallEventRecord,
  ToolCallRecord
} from '../../shared/protocol';
import { createDefaultAgentRecord, DEFAULT_AGENT_NAME, DEFAULT_SESSION_ID } from './defaults';
import { DEFAULT_LLM_MODEL } from '../capabilities';

/**
 * 把持久化 ClientState 投影恢复成 ECS 实体/组件。
 * 这里只做数据形态转换，不负责读取文件，也不负责调度系统。
 */
export function hydrateClientState(world: World, state: ClientState): boolean {
  const hasAnyState = state.agents.length > 0 || state.sessions.length > 0 || state.messages.length > 0;
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
    world.add(entity, ModelProfile, normalizeModelProfile(agent.model));
    world.add(entity, ToolPolicy, normalizeToolPolicy(agent.toolPolicy));
    world.add(entity, SystemPrompt, { text: agent.systemPrompt || defaultAgent.systemPrompt || '' });
  }

  for (const agent of agents) {
    if (!agent.parentAgentId) continue;
    const entity = agentEntities.get(agent.id);
    const parent = agentEntities.get(agent.parentAgentId);
    if (entity !== undefined && parent !== undefined) {
      world.add(entity, ParentAgent, { parent });
    }
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
    streamOutputDurationMs: record.streamOutputDurationMs
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

function normalizeModelProfile(model: AgentRecord['model']): ModelProfileData {
  return {
    provider: isKnownLlmProvider(model?.provider) ? model.provider : 'deepseek',
    model: model?.model || DEFAULT_LLM_MODEL,
    temperature: model?.temperature
  };
}

function normalizeToolPolicy(toolPolicy: AgentRecord['toolPolicy']): ToolPolicyData {
  const approvalMode = toolPolicy?.approvalMode === 'always' || toolPolicy?.approvalMode === 'onRisk' || toolPolicy?.approvalMode === 'never'
    ? toolPolicy.approvalMode
    : 'never';
  return {
    allowedTools: Array.isArray(toolPolicy?.allowedTools) && toolPolicy.allowedTools.length > 0
      ? toolPolicy.allowedTools
      : ['read_file', 'shell', 'bash'],
    approvalMode
  };
}

function isKnownLlmProvider(provider: string | undefined): provider is ModelProfileData['provider'] {
  return provider === 'deepseek' || provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'claude' || provider === 'gemini';
}
