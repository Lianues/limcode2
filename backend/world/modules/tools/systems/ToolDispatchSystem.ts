import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent, AgentConversationLink } from '../../agent/components';
import { InFlight, PartOf, Session } from '../../chat/components';
import { AgentMode, AgentModeLink, ModeToolPolicyLink, ToolPolicy, type ToolPolicyData } from '../../mode/components';
import { ToolCallEventBundle, spawnToolCallEvent } from '../bundles';
import { ToolCall, ToolState, type ToolCallData, type ToolStateData } from '../components';
import { ToolEventType, type ToolExecuteRequestedPayload } from '../events';
import { transitionToolState } from '../state';

const QueuedToolCallsQuery = defineQuery({
  name: 'QueuedToolCalls',
  all: [ToolCall, ToolState],
  none: [InFlight],
  read: [
    ToolCall,
    ToolState,
    PartOf,
    Session,
    Agent,
    AgentConversationLink,
    AgentMode,
    AgentModeLink,
    ModeToolPolicyLink,
    ToolPolicy
  ],
  write: [ToolState],
  add: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

export const ToolDispatchSystem = defineSystem({
  name: 'ToolDispatchSystem',
  worker: { modulePath: '../world/modules/tools/systems/ToolDispatchSystem', exportName: 'ToolDispatchSystem' },
  access: {
    queries: [QueuedToolCallsQuery],
    bundles: [ToolCallEventBundle],
    events: { read: [ToolEventType.ExecuteRequested] },
    effects: { emit: ['tool.run'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const handled = new Set<Entity>();

    for (const request of readEvents(ctx, ToolEventType.ExecuteRequested)) {
      const entity = findToolCall(world, request.toolCallId);
      if (entity === undefined || handled.has(entity)) continue;
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state || world.has(entity, InFlight) || isSettledOrRunning(state)) continue;
      handled.add(entity);

      const authorization = authorizeManualExecution(world, entity, call, request);
      if (!authorization.ok) {
        rejectToolCall(cmd, entity, call, state, authorization.reason, request.executorAgentId, request.executorModeId);
        continue;
      }

      executeToolCall(cmd, entity, call, state, request.executorAgentId, request.executorModeId);
    }

    const calls = world
      .query(ToolCall, ToolState)
      .filter((entity) => !handled.has(entity) && !world.has(entity, InFlight) && world.get(entity, ToolState)?.status === 'queued');
    if (calls.length === 0) return;

    for (const entity of calls) {
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state) continue;

      const executor = resolveActiveExecutorForToolCall(world, entity);
      if (!executor.ok) {
        rejectToolCall(cmd, entity, call, state, executor.reason);
        continue;
      }

      const authorization = authorizeToolName(call.name, executor.policy, executor.agentId, executor.modeId);
      if (!authorization.ok) {
        rejectToolCall(cmd, entity, call, state, authorization.reason, executor.agentId, executor.modeId);
        continue;
      }

      if (requiresApproval(executor.policy, call.name)) {
        awaitApproval(cmd, entity, call, state, executor.agentId, executor.modeId);
        continue;
      }

      executeToolCall(cmd, entity, call, state, executor.agentId, executor.modeId);
    }
  }
});

type AuthorizationResult =
  | { ok: true; policy: ToolPolicyData; agentId: string; modeId: string }
  | { ok: false; reason: string };

function findToolCall(world: WorldReader, toolCallId: string): Entity | undefined {
  return world.query(ToolCall, ToolState).find((candidate) => world.get(candidate, ToolCall)?.id === toolCallId);
}

function isSettledOrRunning(state: ToolStateData): boolean {
  return state.status === 'executing' || state.status === 'success' || state.status === 'warning' || state.status === 'error';
}

function authorizeManualExecution(
  world: WorldReader,
  toolCall: Entity,
  call: ToolCallData,
  request: ToolExecuteRequestedPayload
): AuthorizationResult {
  const session = sessionForToolCall(world, toolCall);
  if (session === undefined) return { ok: false, reason: '无法定位工具调用所属会话。' };

  const agent = findAgentById(world, request.executorAgentId);
  if (agent === undefined) return { ok: false, reason: `执行 Agent 不存在：${request.executorAgentId}` };
  if (!isAgentLinkedToSession(world, agent, session, request.sessionId)) {
    return { ok: false, reason: `Agent ${request.executorAgentId} 未绑定到当前会话，不能执行该工具。` };
  }

  const mode = findModeById(world, request.executorModeId);
  if (mode === undefined) return { ok: false, reason: `执行 Mode 不存在：${request.executorModeId}` };
  if (!isModeLinkedToAgent(world, agent, mode)) {
    return { ok: false, reason: `Mode ${request.executorModeId} 未绑定到 Agent ${request.executorAgentId}。` };
  }

  const policy = activeToolPolicyForMode(world, mode);
  if (!policy) return { ok: false, reason: `Mode ${request.executorModeId} 没有 active ToolPolicy。` };

  return authorizeToolName(call.name, policy, request.executorAgentId, request.executorModeId);
}

function resolveActiveExecutorForToolCall(world: WorldReader, toolCall: Entity): AuthorizationResult {
  const session = sessionForToolCall(world, toolCall);
  if (session === undefined) return { ok: false, reason: '无法定位工具调用所属会话。' };

  const agent = activeAgentForConversation(world, session);
  if (agent === undefined) return { ok: false, reason: '当前会话没有 active Agent，无法执行工具。' };
  const agentRecord = world.get(agent, Agent);
  const mode = activeModeForAgent(world, agent);
  if (mode === undefined) return { ok: false, reason: `Agent ${agentRecord?.id ?? agent} 没有 active Mode，无法执行工具。` };
  const modeRecord = world.get(mode, AgentMode);
  const policy = activeToolPolicyForMode(world, mode);
  if (!policy) return { ok: false, reason: `Mode ${modeRecord?.id ?? mode} 没有 active ToolPolicy。` };

  return { ok: true, policy, agentId: agentRecord?.id ?? String(agent), modeId: modeRecord?.id ?? String(mode) };
}

function authorizeToolName(toolName: string, policy: ToolPolicyData, agentId: string, modeId: string): AuthorizationResult {
  if (!policy.allowedTools.includes(toolName)) {
    return { ok: false, reason: `Agent ${agentId} 的当前 Mode ${modeId} 不允许执行工具 ${toolName}。` };
  }
  return { ok: true, policy, agentId, modeId };
}

function sessionForToolCall(world: WorldReader, toolCall: Entity): Entity | undefined {
  const modelMessage = world.get(toolCall, PartOf)?.parent;
  if (modelMessage === undefined) return undefined;
  return world.get(modelMessage, PartOf)?.parent;
}

function findAgentById(world: WorldReader, agentId: string): Entity | undefined {
  return world.query(Agent).find((entity) => world.get(entity, Agent)?.id === agentId);
}

function findModeById(world: WorldReader, modeId: string): Entity | undefined {
  return world.query(AgentMode).find((entity) => world.get(entity, AgentMode)?.id === modeId);
}

function isAgentLinkedToSession(world: WorldReader, agent: Entity, session: Entity, sessionId: string): boolean {
  const sessionRecord = world.get(session, Session);
  if (sessionRecord?.id !== sessionId) return false;
  return world.query(AgentConversationLink).some((entity) => {
    const link = world.get(entity, AgentConversationLink);
    return !!link && link.agent === agent && link.conversation === session;
  });
}

function isModeLinkedToAgent(world: WorldReader, agent: Entity, mode: Entity): boolean {
  return world.query(AgentModeLink).some((entity) => {
    const link = world.get(entity, AgentModeLink);
    return !!link && link.agent === agent && link.mode === mode;
  });
}

function activeAgentForConversation(world: WorldReader, conversation: Entity): Entity | undefined {
  const links = world
    .query(AgentConversationLink)
    .map((entity) => world.get(entity, AgentConversationLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.conversation === conversation);

  return links.find((link) => link.role === 'active')?.agent ?? links[0]?.agent;
}

function activeModeForAgent(world: WorldReader, agent: Entity): Entity | undefined {
  const links = world
    .query(AgentModeLink)
    .map((entity) => world.get(entity, AgentModeLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.agent === agent);

  return links.find((link) => link.role === 'active')?.mode
    ?? links.find((link) => link.role === 'default')?.mode
    ?? links[0]?.mode;
}

function activeToolPolicyForMode(world: WorldReader, mode: Entity): ToolPolicyData | undefined {
  const link = world
    .query(ModeToolPolicyLink)
    .map((entity) => world.get(entity, ModeToolPolicyLink))
    .find((candidate) => candidate?.mode === mode && candidate.role === 'active');
  return link ? world.get(link.toolPolicy, ToolPolicy) : undefined;
}

function requiresApproval(policy: ToolPolicyData, toolName: string): boolean {
  if (policy.approvalMode === 'always') return true;
  if (policy.approvalMode === 'never') return false;
  return toolName === 'shell' || toolName === 'bash';
}

function executeToolCall(cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, executorAgentId?: string, executorModeId?: string): void {
  cmd.effect({ kind: 'tool.run', toolCallId: call.id, name: call.name, argsJson: call.argsJson });
  const now = Date.now();
  cmd.add(entity, ToolState, transitionToolState(state, 'executing', {}, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'started',
    status: 'executing',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    payload: { executorAgentId, executorModeId }
  });
  cmd.add(entity, InFlight, { kind: 'tool', startedAt: now });
}

function awaitApproval(cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, executorAgentId: string, executorModeId: string): void {
  const now = Date.now();
  cmd.add(entity, ToolState, transitionToolState(state, 'awaiting_approval', {}, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'state',
    status: 'awaiting_approval',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    payload: { executorAgentId, executorModeId, reason: 'requires_approval' }
  });
}

function rejectToolCall(cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, reason: string, executorAgentId?: string, executorModeId?: string): void {
  const now = Date.now();
  const result = { ok: false, denied: true, reason };
  cmd.add(entity, ToolState, transitionToolState(state, 'error', { error: reason, result, durationMs: 0 }, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'failed',
    status: 'error',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    durationMs: 0,
    payload: { executorAgentId, executorModeId, denied: true, reason },
    error: reason
  });
}
