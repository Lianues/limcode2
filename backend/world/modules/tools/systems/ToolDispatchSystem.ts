import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent, AgentConversationLink } from '../../agent/components';
import { AgentBlueprintsKey } from '../../agent/blueprints';
import { linkAgentToConversation, spawnAgentFromBlueprint } from '../../agent/bundles';
import { InFlight, PartOf, Conversation } from '../../chat/components';
import { spawnConversation, spawnUserMessage } from '../../chat/bundles';
import { AgentMode, AgentModeLink, ApprovalPolicy, ModeApprovalPolicyLink, ModeToolPolicyLink, ModelProfile, SystemPrompt, ToolPolicy, type ApprovalPolicyData, type ToolPolicyData } from '../../mode/components';
import { AgentRun, RunApprovalPolicyLink, RunDeliveryPolicy, RunModeLink, RunModelProfileLink, RunSystemPromptLink, RunToolPolicyLink, ToolCallRunLink } from '../../agentRun/components';
import { spawnAgentRun } from '../../agentRun/bundles';
import { activeApprovalPolicyForRun, activeToolPolicyForRun, runForToolCall, runTarget, toolCallEntityById } from '../../agentRun/queries';
import { ToolCallEventBundle, spawnToolCallEvent } from '../bundles';
import { ToolCall, ToolState, type ToolCallData, type ToolStateData } from '../components';
import { ToolEventType, type ToolExecuteRequestedPayload } from '../events';
import { transitionToolState } from '../state';
import { ToolSchemasKey } from '../resources';

const QueuedToolCallsQuery = defineQuery({
  name: 'QueuedToolCalls',
  all: [ToolCall, ToolState],
  none: [InFlight],
  read: [
    ToolCall,
    ToolState,
    PartOf,
    Conversation,
    Agent,
    AgentConversationLink,
    AgentMode,
    AgentModeLink,
    ModeToolPolicyLink,
    ModeApprovalPolicyLink,
    ToolPolicy,
    ApprovalPolicy,
    AgentRun,
    ToolCallRunLink
  ],
  write: [ToolState, AgentRun],
  add: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

export const ToolDispatchSystem = defineSystem({
  name: 'ToolDispatchSystem',
  access: {
    queries: [QueuedToolCallsQuery],
    resources: { read: [AgentBlueprintsKey, ToolSchemasKey] },
    bundles: [ToolCallEventBundle],
    events: { read: [ToolEventType.ExecuteRequested] },
    effects: { emit: ['tool.run'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const handled = new Set<Entity>();

    for (const request of readEvents(ctx, ToolEventType.ExecuteRequested)) {
      const entity = toolCallEntityById(world, request.toolCallId);
      if (entity === undefined || handled.has(entity)) continue;
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state || world.has(entity, InFlight) || isSettledOrRunning(state)) continue;
      handled.add(entity);

      const authorization = authorizeRunToolExecution(world, entity, call);
      if (!authorization.ok) {
        rejectToolCall(cmd, entity, call, state, authorization.reason);
        continue;
      }
      dispatchToolCall(world, cmd, entity, call, state, authorization);
    }

    const calls = world
      .query(ToolCall, ToolState)
      .filter((entity) => !handled.has(entity) && !world.has(entity, InFlight) && world.get(entity, ToolState)?.status === 'queued');
    if (calls.length === 0) return;

    for (const entity of calls) {
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state) continue;

      const authorization = authorizeRunToolExecution(world, entity, call);
      if (!authorization.ok) {
        rejectToolCall(cmd, entity, call, state, authorization.reason);
        continue;
      }

      if (requiresApproval(authorization.approvalPolicy, call.name)) {
        awaitApproval(cmd, entity, call, state, authorization.agentId, authorization.runId);
        continue;
      }

      dispatchToolCall(world, cmd, entity, call, state, authorization);
    }
  }
});

type AuthorizationResult =
  | { ok: true; run: Entity; runId: string; policy: ToolPolicyData; approvalPolicy: ApprovalPolicyData | undefined; agentId: string; conversationId: string }
  | { ok: false; reason: string };

function isSettledOrRunning(state: ToolStateData): boolean {
  return state.status === 'executing' || state.status === 'success' || state.status === 'warning' || state.status === 'error';
}

function authorizeRunToolExecution(world: WorldReader, toolCall: Entity, call: ToolCallData): AuthorizationResult {
  const run = runForToolCall(world, toolCall);
  if (run === undefined) return { ok: false, reason: '工具调用没有关联 AgentRun，无法执行。' };
  const target = runTarget(world, run);
  if (!target) return { ok: false, reason: '工具调用所属 AgentRun 没有目标 Agent/Conversation。' };
  const agent = world.get(target.agent, Agent);
  const conversation = world.get(target.conversation, Conversation);
  const policy = activeToolPolicyForRun(world, run);
  if (!policy) return { ok: false, reason: `AgentRun ${world.get(run, AgentRun)?.id ?? run} 没有 active ToolPolicy。` };
  if (!policy.allowedTools.includes(call.name)) {
    return { ok: false, reason: `AgentRun ${world.get(run, AgentRun)?.id ?? run} 不允许执行工具 ${call.name}。` };
  }
  return {
    ok: true,
    run,
    runId: world.get(run, AgentRun)?.id ?? String(run),
    policy,
    approvalPolicy: activeApprovalPolicyForRun(world, run),
    agentId: agent?.id ?? String(target.agent),
    conversationId: conversation?.id ?? String(target.conversation)
  };
}

function dispatchToolCall(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  if (call.name === 'sub_agent') {
    executeSubAgentTool(world, cmd, entity, call, state, authorization);
    return;
  }
  executeRuntimeToolCall(cmd, entity, call, state, authorization);
}

function executeRuntimeToolCall(cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  cmd.effect({ kind: 'tool.run', toolCallId: call.id, name: call.name, argsJson: call.argsJson, runId: authorization.runId, conversationId: authorization.conversationId });
  const now = Date.now();
  cmd.add(entity, ToolState, transitionToolState(state, 'executing', {}, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'started',
    status: 'executing',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    payload: { executorAgentId: authorization.agentId, runId: authorization.runId }
  });
  cmd.add(entity, InFlight, { kind: 'tool', startedAt: now });
}

interface SubAgentArgs {
  prompt?: string;
  type?: string;
  context?: string;
  run_in_background?: boolean;
  conversation?: { mode?: string; conversationId?: string; history?: string; lastN?: number };
  delivery?: { mode?: string; includeTranscript?: string };
  mode?: { modeId?: string; systemPromptId?: string; modelProfileId?: string; toolPolicyId?: string; approvalPolicyId?: string };
}

function executeSubAgentTool(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  let args: SubAgentArgs = {};
  try {
    args = call.argsJson ? JSON.parse(call.argsJson) as SubAgentArgs : {};
  } catch (error) {
    rejectToolCall(cmd, entity, call, state, `sub_agent 参数不是合法 JSON: ${String(error)}`);
    return;
  }
  const prompt = args.prompt?.trim();
  if (!prompt) {
    rejectToolCall(cmd, entity, call, state, 'sub_agent 缺少必填 prompt。');
    return;
  }

  const parentTarget = runTarget(world, authorization.run);
  if (!parentTarget) {
    rejectToolCall(cmd, entity, call, state, '无法解析父 AgentRun 目标。');
    return;
  }

  const kind = args.type?.trim() || 'general-purpose';
  const blueprints = world.getResource(AgentBlueprintsKey);
  const blueprint = blueprints[kind];
  if (!blueprint) {
    rejectToolCall(cmd, entity, call, state, `未知 Agent 类型: ${kind}`);
    return;
  }

  const fullPrompt = args.context?.trim()
    ? `Context:\n${args.context.trim()}\n\nTask:\n${prompt}`
    : prompt;
  const mode = args.conversation?.mode ?? 'fresh';
  const useSameConversation = mode === 'same';
  const targetAgent = findAgentByKind(world, kind);
  let childAgent: Entity;
  let childConversation: Entity;

  if (targetAgent !== undefined) {
    childAgent = targetAgent;
    if (useSameConversation) {
      childConversation = parentTarget.conversation;
    } else {
      childConversation = spawnConversation(cmd, { id: `conversation-${kind}-${entity}`, title: `${kind}: ${prompt.slice(0, 40)}`, visibility: 'collapsed' });
      linkAgentToConversation(cmd, { agent: childAgent, conversation: childConversation, role: 'default' });
    }
  } else {
    const spawned = spawnAgentFromBlueprint(cmd, {
      blueprint,
      agentId: `${kind}-${entity}`,
      agentName: blueprint.name,
      conversationId: useSameConversation ? `conversation-${kind}-${entity}` : `conversation-${kind}-${entity}`,
      conversationTitle: `${kind}: ${prompt.slice(0, 40)}`
    });
    childAgent = spawned.agent;
    childConversation = useSameConversation ? parentTarget.conversation : spawned.conversation;
    if (useSameConversation) linkAgentToConversation(cmd, { agent: childAgent, conversation: childConversation, role: 'participant' });
  }

  const inputMessage = spawnUserMessage(cmd, childConversation, fullPrompt);
  const background = args.run_in_background === true || args.delivery?.mode === 'notification';
  const deliveryMode = background ? 'notification' : 'tool_response';
  const childRun = spawnAgentRun(cmd, {
    kind: 'tool_invoked',
    agent: childAgent,
    conversation: childConversation,
    sourceKind: 'toolCall',
    sourceAgent: parentTarget.agent,
    sourceConversation: parentTarget.conversation,
    sourceToolCall: entity,
    sourceRun: authorization.run,
    inputMessage,
    deliveryMode,
    includeTranscript: args.delivery?.includeTranscript === 'full' ? 'full' : 'summary'
  });
  applyRunModeOverrides(world, cmd, childRun, args.mode);

  const now = Date.now();
  if (background) {
    const result = { status: 'async_launched', runId: world.get(childRun, AgentRun)?.id ?? `run${childRun}`, message: 'AgentRun 已在后台启动，完成后会以 notification 回流。' };
    cmd.add(entity, ToolState, transitionToolState(state, 'success', { result, durationMs: 0 }, now));
    spawnToolCallEvent(cmd, { toolCall: entity, toolCallId: call.id, kind: 'completed', status: 'success', at: now, elapsedMs: Math.max(0, now - call.createdAt), payload: result });
    return;
  }

  cmd.add(entity, ToolState, transitionToolState(state, 'executing', { progress: { childRunId: `run${childRun}` } }, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'started',
    status: 'executing',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    payload: { childRunId: `run${childRun}`, deliveryMode }
  });
  cmd.add(entity, InFlight, { kind: 'tool', startedAt: now });
}

function applyRunModeOverrides(world: WorldReader, cmd: CommandSink, run: Entity, mode?: SubAgentArgs['mode']): void {
  if (!mode) return;
  const now = Date.now();
  const modeEntity = mode.modeId ? findByRecordId(world, AgentMode, mode.modeId) : undefined;
  if (modeEntity !== undefined) {
    const link = cmd.spawn();
    cmd.add(link, RunModeLink, { id: `run-mode:${run}:${mode.modeId}`, run, mode: modeEntity, role: 'active', createdAt: now, updatedAt: now });
  }
  const systemPrompt = mode.systemPromptId ? findByRecordId(world, SystemPrompt, mode.systemPromptId) : undefined;
  if (systemPrompt !== undefined) {
    const link = cmd.spawn();
    cmd.add(link, RunSystemPromptLink, { id: `run-system-prompt:${run}:${mode.systemPromptId}`, run, systemPrompt, role: 'active', createdAt: now, updatedAt: now });
  }
  const modelProfile = mode.modelProfileId ? findByRecordId(world, ModelProfile, mode.modelProfileId) : undefined;
  if (modelProfile !== undefined) {
    const link = cmd.spawn();
    cmd.add(link, RunModelProfileLink, { id: `run-model-profile:${run}:${mode.modelProfileId}`, run, modelProfile, role: 'active', createdAt: now, updatedAt: now });
  }
  const toolPolicy = mode.toolPolicyId ? findByRecordId(world, ToolPolicy, mode.toolPolicyId) : undefined;
  if (toolPolicy !== undefined) {
    const link = cmd.spawn();
    cmd.add(link, RunToolPolicyLink, { id: `run-tool-policy:${run}:${mode.toolPolicyId}`, run, toolPolicy, role: 'active', createdAt: now, updatedAt: now });
  }
  const approvalPolicy = mode.approvalPolicyId ? findByRecordId(world, ApprovalPolicy, mode.approvalPolicyId) : undefined;
  if (approvalPolicy !== undefined) {
    const link = cmd.spawn();
    cmd.add(link, RunApprovalPolicyLink, { id: `run-approval-policy:${run}:${mode.approvalPolicyId}`, run, approvalPolicy, role: 'active', createdAt: now, updatedAt: now });
  }
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: { id: symbol }, id: string): Entity | undefined {
  return world.query(component as never).find((entity) => (world.get(entity, component as never) as T | undefined)?.id === id);
}

function findAgentByKind(world: WorldReader, kind: string): Entity | undefined {
  return world.query(Agent).find((agent) => world.get(agent, Agent)?.id === kind || world.get(agent, Agent)?.name === kind);
}

function requiresApproval(policy: ApprovalPolicyData | undefined, toolName: string): boolean {
  if (!policy) return false;
  if (policy.mode === 'always' || policy.mode === 'manualOnly') return policy.allowInteractiveApproval;
  if (policy.mode === 'never') return false;
  return toolName === 'shell' || toolName === 'bash';
}

function awaitApproval(cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, executorAgentId: string, runId: string): void {
  const now = Date.now();
  cmd.add(entity, ToolState, transitionToolState(state, 'awaiting_approval', {}, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'state',
    status: 'awaiting_approval',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    payload: { executorAgentId, runId, reason: 'requires_approval' }
  });
}

function rejectToolCall(cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, reason: string): void {
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
    payload: { denied: true, reason },
    error: reason
  });
}
