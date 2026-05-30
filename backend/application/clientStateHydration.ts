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
import type {
  AgentConversationLinkRecord,
  AgentRecord,
  ClientState,
  MessageRecord
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
    world.add(entity, Session, { id: session.id });
  }

  for (const link of state.agentConversationLinks) {
    spawnHydratedAgentConversationLink(world, agentEntities, sessionEntities, link);
  }

  for (const record of state.messages) {
    const sessionEntity = sessionEntities.get(record.sessionId);
    if (sessionEntity === undefined) continue;
    spawnHydratedMessage(world, sessionEntity, record);
  }

  return true;
}

function spawnHydratedMessage(world: World, session: Entity, record: MessageRecord): void {
  const entity = world.spawn();
  world.add(entity, Message, {
    id: record.id,
    role: record.role,
    text: record.text,
    status: record.status === 'streaming' ? 'error' : record.status,
    seq: record.seq,
    createdAt: Date.now()
  });
  world.add(entity, PartOf, { parent: session });
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
    allowedTools: Array.isArray(toolPolicy?.allowedTools) ? toolPolicy.allowedTools : [],
    approvalMode
  };
}

function isKnownLlmProvider(provider: string | undefined): provider is ModelProfileData['provider'] {
  return provider === 'deepseek' || provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'claude' || provider === 'gemini';
}
