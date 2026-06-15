import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent, AgentConversationLink, AgentKind } from '../../agent/components';
import {
  AgentBlueprintsKey,
  type AgentBlueprint,
  type AgentModeBlueprint,
  type RunContextPolicyBlueprint,
  type RunConversationPolicyBlueprint,
  type RunDeliveryPolicyBlueprint,
  type RunEditPolicyBlueprint
} from '../../agent/blueprints';
import { AgentFromBlueprintBundle, linkAgentToConversation, spawnAgentFromBlueprint, spawnAgentProfileFromBlueprint } from '../../agent/bundles';
import { Conversation, ConversationBranchLink, ConversationReuseLink, InFlight, Message, MessageRevision, PartOf } from '../../chat/components';
import {
  cloneMessageToConversation,
  ConversationBundle,
  ConversationLinkBundle,
  MessageBundle,
  spawnConversation,
  spawnConversationBranchLink,
  spawnConversationReuseLink,
  spawnUserMessage
} from '../../chat/bundles';
import { conversationMessages } from '../../chat/queries';
import {
  AgentModeLink,
  ConversationModeSelection,
  Mode,
  ModeToolPolicyLink,
  ModelProfile,
  SystemPrompt,
  ToolPolicy,
  type ToolPolicyData
} from '../../mode/components';
import {
  AgentRun,
  RunContextPolicy,
  RunContextPolicyLink,
  RunConversationPolicy,
  RunConversationPolicyLink,
  RunDeliveryPolicy,
  type RunDeliveryPolicyData,
  RunDeliveryPolicyLink,
  RunEditPolicy,
  RunEditPolicyLink,
  RunModeLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from '../../agentRun/components';
import { AgentRunBundle, spawnAgentRun } from '../../agentRun/bundles';
import { activeToolPolicyForRun, runForToolCall, runTarget, toolCallEntityById } from '../../agentRun/queries';
import { ToolCallEventBundle, spawnToolCallEvent } from '../bundles';
import { ToolCall, ToolPolicyScopeLink, ToolResultConsumed, ToolState, type ToolCallData, type ToolStateData } from '../components';
import { ToolEventType } from '../events';
import { transitionToolState } from '../state';
import { ToolDefinitionsKey, ToolRuntimeDefinitionsKey, ToolSchemasKey } from '../resources';
import {
  compareToolCallOrder,
  isExecutionApproved,
  isInActiveExecutionBatch,
  progressRecord
} from '../scheduling';
import type {
  AgentRunStatus,
  ContextHistoryMode,
  ConversationPolicyMode,
  ConversationVisibility,
  DeliveryMode,
  MessageContent,
  NewMessageWhileRunningBehavior,
  SourceEditBehavior,
  ToolConfigRecord,
  TranscriptInclusion
} from '../../../../../shared/protocol';

const QueuedToolCallsQuery = defineQuery({
  name: 'QueuedToolCalls',
  all: [ToolCall, ToolState],
  none: [InFlight],
  read: [
    ToolCall,
    ToolState,
    PartOf,
    Conversation,
    ConversationReuseLink,
    ConversationBranchLink,
    Message,
    MessageRevision,
    Agent,
    AgentConversationLink,
    ConversationModeSelection,
    Mode,
    AgentModeLink,
    ModeToolPolicyLink,
    ToolPolicy,
    ToolPolicyScopeLink,
    AgentRun,
    ToolCallRunLink,
    ToolResultConsumed
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
    resources: { read: [AgentBlueprintsKey, ToolSchemasKey, ToolDefinitionsKey, ToolRuntimeDefinitionsKey] },
    bundles: [ToolCallEventBundle, ConversationBundle, ConversationLinkBundle, MessageBundle, AgentRunBundle, AgentFromBlueprintBundle],
    events: { read: [ToolEventType.ExecutionApproveRequested, ToolEventType.ExecutionRejectRequested] },
    effects: { emit: ['tool.run'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const handled = new Set<Entity>();

    for (const request of readEvents(ctx, ToolEventType.ExecutionRejectRequested)) {
      const entity = toolCallEntityById(world, request.toolCallId);
      if (entity === undefined || handled.has(entity)) continue;
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state || state.status !== 'awaiting_approval') continue;
      handled.add(entity);
      rejectToolCall(cmd, entity, call, state, request.reason?.trim() || '用户拒绝执行工具。');
    }

    for (const request of readEvents(ctx, ToolEventType.ExecutionApproveRequested)) {
      const entity = toolCallEntityById(world, request.toolCallId);
      if (entity === undefined || handled.has(entity)) continue;
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state || world.has(entity, InFlight) || isSettledOrRunning(state)) continue;
      if (state.status !== 'awaiting_approval' && state.status !== 'queued') continue;
      handled.add(entity);

      const authorization = authorizeRunToolExecution(world, entity, call);
      if (!authorization.ok) {
        rejectToolCall(cmd, entity, call, state, authorization.reason);
        continue;
      }
      if (!isRunReadyForToolExecution(authorization)) continue;
      if (!isInActiveExecutionBatch(world, authorization.run, entity)) {
        markExecutionApproved(cmd, entity, call, state, authorization, true);
        continue;
      }
      dispatchToolCall(world, cmd, entity, call, state, authorization);
    }

    dispatchApprovedAwaitingCalls(world, cmd, handled);

    const calls = world
      .query(ToolCall, ToolState)
      .filter((entity) => !handled.has(entity) && !world.has(entity, InFlight) && world.get(entity, ToolState)?.status === 'queued')
      .sort((left, right) => compareToolCallOrder(world, left, right));
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
      if (!isRunReadyForToolExecution(authorization)) continue;
      if (!isInActiveExecutionBatch(world, authorization.run, entity)) {
        continue;
      }

      if (requiresExecutionApproval(authorization.policy, call.name)) {
        awaitApproval(cmd, entity, call, state, authorization.agentId, authorization.runId);
        continue;
      }

      dispatchToolCall(world, cmd, entity, call, state, authorization);
    }
  }
});

type AuthorizationResult =
  | { ok: true; run: Entity; runId: string; runStatus: AgentRunStatus; policy: ToolPolicyData; agentId: string; conversationId: string }
  | { ok: false; reason: string };

function isSettledOrRunning(state: ToolStateData): boolean {
  return state.status === 'executing' || state.status === 'success' || state.status === 'warning' || state.status === 'error';
}

function authorizeRunToolExecution(world: WorldReader, toolCall: Entity, call: ToolCallData): AuthorizationResult {
  const run = runForToolCall(world, toolCall);
  if (run === undefined) return { ok: false, reason: '工具调用没有关联 AgentRun，无法执行。' };
  const runData = world.get(run, AgentRun);
  if (!runData) return { ok: false, reason: '工具调用关联的 AgentRun 不存在。' };
  const target = runTarget(world, run);
  if (!target) return { ok: false, reason: '工具调用所属 AgentRun 没有目标 Agent/Conversation。' };
  const agent = world.get(target.agent, Agent);
  const conversation = world.get(target.conversation, Conversation);
  const policy = activeToolPolicyForRun(world, run);
  if (!policy) return { ok: false, reason: `AgentRun ${runData.id} 没有 active ToolPolicy。` };
  if (!policy.allowedTools.includes(call.name)) {
    return { ok: false, reason: `AgentRun ${runData.id} 不允许执行工具 ${call.name}。` };
  }
  return {
    ok: true,
    run,
    runId: runData.id,
    runStatus: runData.status,
    policy,
    agentId: agent?.id ?? String(target.agent),
    conversationId: conversation?.id ?? String(target.conversation)
  };
}

function isRunReadyForToolExecution(authorization: Extract<AuthorizationResult, { ok: true }>): boolean {
  return authorization.runStatus === 'waiting_tool';
}

function dispatchToolCall(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  if (isAgentRunTool(world, call.name)) {
    executeRunAgentTool(world, cmd, entity, call, state, authorization);
    return;
  }
  executeRuntimeToolCall(world, cmd, entity, call, state, authorization);
}

function executeRuntimeToolCall(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  cmd.effect({ kind: 'tool.run', toolCallId: call.id, name: call.name, argsJson: call.argsJson, runId: authorization.runId, conversationId: authorization.conversationId, config: effectiveToolConfig(world, authorization.policy, call.name) });
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

interface RunAgentArgs {
  prompt?: string;
  agentId?: string;
  type?: string;
  agent?: {
    id?: string;
    type?: string;
    name?: string;
    createIfMissing?: boolean;
  };
  context?: string;
  run_in_background?: boolean;
  conversation?: {
    mode?: string;
    conversationId?: string;
    reuseKey?: string;
    history?: string;
    lastN?: number;
    sinceMessageId?: string;
    selectedMessageIds?: string[];
    branchFromRevisionId?: string;
    revisionId?: string;
    visibility?: ConversationVisibility;
    includeSourceContext?: boolean;
    includeSourceToolResult?: boolean;
  };
  delivery?: { mode?: string; includeTranscript?: string };
  mode?: {
    modeId?: string;
    systemPromptId?: string;
    modelProfileId?: string;
    toolPolicyId?: string;
    contextPolicyId?: string;
    deliveryPolicyId?: string;
    editPolicyId?: string;
    contextPolicy?: {
      historyMode?: string;
      lastN?: number;
      sinceMessageId?: string;
      selectedMessageIds?: string[];
      includeSourceContext?: boolean;
      includeSourceToolResult?: boolean;
    };
    deliveryPolicy?: { mode?: string; includeTranscript?: string };
    editPolicy?: { onSourceEdited?: string; onNewUserMessageWhileRunning?: string };
  };
}

interface ResolvedConversation {
  conversation: Entity;
  policyMode: ConversationPolicyMode;
  reuseKey?: string;
  branchRevision?: Entity;
  visibility?: ConversationVisibility;
  explicitConversationId?: string;
  branchFromRevisionId?: string;
}

interface ResolvedRunAgentPolicyDefaults {
  conversationPolicy: RunConversationPolicyBlueprint;
  contextPolicy: RunContextPolicyBlueprint;
  deliveryPolicy: RunDeliveryPolicyBlueprint;
  editPolicy: RunEditPolicyBlueprint;
}

function resolveTargetModeBlueprint(blueprint: AgentBlueprint, modeId: string | undefined): AgentModeBlueprint | undefined {
  if (modeId) {
    const explicit = blueprint.modes.find((mode) => mode.id === modeId || modeId.endsWith(`:mode:${mode.id}`));
    if (explicit) return explicit;
  }
  return blueprint.modes.find((mode) => mode.id === blueprint.defaultModeId) ?? blueprint.modes[0];
}

function resolveRunAgentPolicyDefaults(blueprint: AgentBlueprint, mode: AgentModeBlueprint | undefined): ResolvedRunAgentPolicyDefaults {
  return {
    conversationPolicy: mode?.conversationPolicy ?? blueprint.defaultConversationPolicy ?? { mode: 'new_conversation', visibility: 'collapsed' },
    contextPolicy: mode?.contextPolicy ?? blueprint.defaultContextPolicy ?? { historyMode: 'full' },
    deliveryPolicy: mode?.deliveryPolicy ?? blueprint.defaultDeliveryPolicy ?? { mode: 'tool_response', includeTranscript: 'summary' },
    editPolicy: mode?.editPolicy ?? blueprint.defaultEditPolicy ?? { onSourceEdited: 'mark_stale', onNewUserMessageWhileRunning: 'queue_next_run' }
  };
}

function resolveDeliveryPolicy(
  args: RunAgentArgs,
  defaultPolicy: RunDeliveryPolicyBlueprint,
  background: boolean,
  linkedPolicy?: RunDeliveryPolicyData
): RunDeliveryPolicyBlueprint {
  const mode = normalizeDeliveryMode(
    args.delivery?.mode ?? args.mode?.deliveryPolicy?.mode ?? linkedPolicy?.mode ?? defaultPolicy.mode,
    background
  );
  return {
    mode,
    includeTranscript: normalizeTranscript(args.delivery?.includeTranscript ?? args.mode?.deliveryPolicy?.includeTranscript ?? linkedPolicy?.includeTranscript ?? defaultPolicy.includeTranscript)
  };
}

function executeRunAgentTool(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  let args: RunAgentArgs = {};
  try {
    args = call.argsJson ? JSON.parse(call.argsJson) as RunAgentArgs : {};
  } catch (error) {
    rejectToolCall(cmd, entity, call, state, `run_agent 参数不是合法 JSON: ${String(error)}`);
    return;
  }
  const prompt = args.prompt?.trim();
  if (!prompt) {
    rejectToolCall(cmd, entity, call, state, 'run_agent 缺少必填 prompt。');
    return;
  }

  const parentTarget = runTarget(world, authorization.run);
  if (!parentTarget) {
    rejectToolCall(cmd, entity, call, state, '无法解析父 AgentRun 目标。');
    return;
  }

  const requestedAgentId = args.agent?.id?.trim() || args.agentId?.trim();
  const requestedKind = args.agent?.type?.trim() || args.type?.trim();
  const blueprints = world.getResource(AgentBlueprintsKey);
  const existingAgent = requestedAgentId ? findAgentById(world, requestedAgentId) : undefined;
  if (requestedAgentId && existingAgent === undefined && args.agent?.createIfMissing !== true) {
    rejectToolCall(cmd, entity, call, state, `指定 Agent 不存在: ${requestedAgentId}`);
    return;
  }
  const kind = requestedKind || (existingAgent !== undefined ? world.get(existingAgent, AgentKind)?.kind : undefined) || 'general-purpose';
  const blueprint = blueprints[kind];
  if (!blueprint) {
    rejectToolCall(cmd, entity, call, state, `未知 Agent 类型: ${kind}`);
    return;
  }

  const targetAgent = existingAgent ?? findAgentByKind(world, kind) ?? spawnAgentProfileFromBlueprint(cmd, { blueprint, agentId: requestedAgentId ?? `${kind}-${entity}`, agentName: args.agent?.name ?? blueprint.name });
  const targetModeBlueprint = resolveTargetModeBlueprint(blueprint, args.mode?.modeId);
  const policyDefaults = resolveRunAgentPolicyDefaults(blueprint, targetModeBlueprint);
  const resolved = resolveTargetConversation(world, cmd, {
    sourceConversation: parentTarget.conversation,
    targetAgent,
    kind,
    toolCallEntity: entity,
    prompt,
    args,
    defaultPolicy: policyDefaults.conversationPolicy
  });
  if (!resolved.ok) {
    rejectToolCall(cmd, entity, call, state, resolved.reason);
    return;
  }

  const fullPrompt = args.context?.trim()
    ? `Context:\n${args.context.trim()}\n\nTask:\n${prompt}`
    : prompt;
  const inputMessage = spawnUserMessage(cmd, resolved.value.conversation, fullPrompt);
  const linkedDeliveryPolicy = args.mode?.deliveryPolicyId ? findByRecordId<RunDeliveryPolicyData>(world, RunDeliveryPolicy, args.mode.deliveryPolicyId) : undefined;
  const launchDeliveryMode = args.delivery?.mode ?? args.mode?.deliveryPolicy?.mode ?? (linkedDeliveryPolicy !== undefined ? world.get(linkedDeliveryPolicy, RunDeliveryPolicy)?.mode : undefined);
  const background = args.run_in_background === true || isAsyncDeliveryMode(launchDeliveryMode);
  const baseDeliveryPolicy = resolveDeliveryPolicy(args, policyDefaults.deliveryPolicy, background, linkedDeliveryPolicy !== undefined ? world.get(linkedDeliveryPolicy, RunDeliveryPolicy) : undefined);
  const deliveryMode = baseDeliveryPolicy.mode;
  const includeTranscript = baseDeliveryPolicy.includeTranscript;
  const childRun = spawnAgentRun(cmd, {
    kind: 'tool_invoked',
    agent: targetAgent,
    conversation: resolved.value.conversation,
    sourceKind: 'toolCall',
    sourceAgent: parentTarget.agent,
    sourceConversation: parentTarget.conversation,
    sourceToolCall: entity,
    sourceRun: authorization.run,
    inputMessage,
    deliveryMode,
    includeTranscript
  });
  applyRunConversationPolicy(cmd, childRun, resolved.value);
  applyRunContextPolicy(cmd, childRun, args, resolved.value, policyDefaults.contextPolicy);
  applyRunDeliveryPolicy(cmd, childRun, baseDeliveryPolicy);
  applyRunEditPolicy(cmd, childRun, policyDefaults.editPolicy);
  applyRunModeOverrides(world, cmd, childRun, args.mode);

  const now = Date.now();
  if (deliveryMode === 'notification' || deliveryMode === 'silent') {
    const result = { status: 'async_launched', runId: `run${childRun}`, conversationId: world.get(resolved.value.conversation, Conversation)?.id, message: 'AgentRun 已在后台启动，完成后会按 delivery policy 回流。' };
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

function resolveTargetConversation(
  world: WorldReader,
  cmd: CommandSink,
  input: { sourceConversation: Entity; targetAgent: Entity; kind: string; toolCallEntity: Entity; prompt: string; args: RunAgentArgs; defaultPolicy: RunConversationPolicyBlueprint }
): { ok: true; value: ResolvedConversation } | { ok: false; reason: string } {
  const conversationArgs = input.args.conversation ?? {};
  const policyMode = conversationArgs.mode ? normalizeConversationPolicyMode(conversationArgs.mode) : input.defaultPolicy.mode;
  const visibility = conversationArgs.visibility ?? input.defaultPolicy.visibility ?? (policyMode === 'same_conversation' || policyMode === 'reuse_conversation' ? 'visible' : 'collapsed');
  const explicitConversationId = conversationArgs.conversationId ?? input.defaultPolicy.conversationId;

  if (explicitConversationId) {
    const explicit = findConversationById(world, explicitConversationId);
    if (explicit === undefined) return { ok: false, reason: `指定 conversation 不存在: ${explicitConversationId}` };
    ensureAgentConversationLink(world, cmd, input.targetAgent, explicit, 'participant');
    if (policyMode === 'fork_conversation') {
      copyProjectedHistory(world, cmd, input.sourceConversation, explicit, conversationArgs);
      spawnConversationBranchLink(cmd, { sourceConversation: input.sourceConversation, targetConversation: explicit, kind: 'fork' });
    }
    if (policyMode === 'branch_from_revision') {
      const branch = copyBranchFromRevision(world, cmd, input.sourceConversation, explicit, conversationArgs.branchFromRevisionId ?? conversationArgs.revisionId);
      if (!branch.ok) return branch;
      spawnConversationBranchLink(cmd, { sourceConversation: input.sourceConversation, targetConversation: explicit, sourceRevision: branch.revision, kind: 'branch_from_revision' });
      return { ok: true, value: { conversation: explicit, policyMode, branchRevision: branch.revision, visibility, explicitConversationId, branchFromRevisionId: conversationArgs.branchFromRevisionId ?? conversationArgs.revisionId } };
    }
    return { ok: true, value: { conversation: explicit, policyMode, reuseKey: conversationArgs.reuseKey ?? input.defaultPolicy.reuseKey, visibility, explicitConversationId } };
  }

  if (policyMode === 'same_conversation') {
    ensureAgentConversationLink(world, cmd, input.targetAgent, input.sourceConversation, 'participant');
    return { ok: true, value: { conversation: input.sourceConversation, policyMode, visibility } };
  }

  if (policyMode === 'reuse_conversation') {
    const reuseKey = conversationArgs.reuseKey?.trim() || input.defaultPolicy.reuseKey || `${input.kind}:default`;
    const reused = findReuseConversation(world, reuseKey, input.targetAgent);
    if (reused !== undefined) {
      ensureAgentConversationLink(world, cmd, input.targetAgent, reused, 'default');
      return { ok: true, value: { conversation: reused, policyMode, reuseKey, visibility } };
    }
    const conversation = spawnConversation(cmd, { id: `conversation-reuse-${slug(reuseKey)}-${input.toolCallEntity}`, title: `${input.kind}: ${reuseKey}`, visibility });
    linkAgentToConversation(cmd, { agent: input.targetAgent, conversation, role: 'default' });
    spawnConversationReuseLink(cmd, { key: reuseKey, conversation, agent: input.targetAgent });
    return { ok: true, value: { conversation, policyMode, reuseKey, visibility } };
  }

  const conversation = spawnConversation(cmd, { id: `conversation-${input.kind}-${input.toolCallEntity}`, title: `${input.kind}: ${input.prompt.slice(0, 40)}`, visibility });
  linkAgentToConversation(cmd, { agent: input.targetAgent, conversation, role: 'default' });

  if (policyMode === 'fork_conversation') {
    copyProjectedHistory(world, cmd, input.sourceConversation, conversation, conversationArgs);
    spawnConversationBranchLink(cmd, { sourceConversation: input.sourceConversation, targetConversation: conversation, kind: 'fork' });
    return { ok: true, value: { conversation, policyMode, visibility } };
  }

  if (policyMode === 'branch_from_revision') {
    const branch = copyBranchFromRevision(world, cmd, input.sourceConversation, conversation, conversationArgs.branchFromRevisionId ?? conversationArgs.revisionId);
    if (!branch.ok) return branch;
    spawnConversationBranchLink(cmd, { sourceConversation: input.sourceConversation, targetConversation: conversation, sourceRevision: branch.revision, kind: 'branch_from_revision' });
    return { ok: true, value: { conversation, policyMode, branchRevision: branch.revision, visibility, branchFromRevisionId: conversationArgs.branchFromRevisionId ?? conversationArgs.revisionId } };
  }

  return { ok: true, value: { conversation, policyMode, visibility } };
}

function copyProjectedHistory(world: WorldReader, cmd: CommandSink, sourceConversation: Entity, targetConversation: Entity, args: NonNullable<RunAgentArgs['conversation']>): void {
  const messages = selectedMessagesForPolicy(world, sourceConversation, normalizeHistoryMode(args.history), args);
  const historyMode = normalizeHistoryMode(args.history);
  if (historyMode === 'summary') {
    const summary = messages.map((entity) => {
      const message = world.get(entity, Message);
      return message ? `${message.role}: ${message.content.parts.map((part) => 'text' in part && part.thought !== true ? part.text : '').join('')}` : '';
    }).filter(Boolean).join('\n\n');
    if (summary.trim()) spawnUserMessage(cmd, targetConversation, `[Projected conversation summary]\n${summary.slice(0, 12000)}`);
    return;
  }
  for (const entity of messages) {
    const message = world.get(entity, Message);
    if (message) cloneMessageToConversation(cmd, targetConversation, message);
  }
}

function copyBranchFromRevision(world: WorldReader, cmd: CommandSink, sourceConversation: Entity, targetConversation: Entity, revisionId: string | undefined): { ok: true; revision: Entity } | { ok: false; reason: string } {
  if (!revisionId) return { ok: false, reason: 'branch_from_revision 需要 branchFromRevisionId/revisionId。' };
  const revision = findRevisionById(world, revisionId);
  if (revision === undefined) return { ok: false, reason: `指定 revision 不存在: ${revisionId}` };
  const sourceMessage = world.get(revision, PartOf)?.parent;
  if (sourceMessage === undefined) return { ok: false, reason: `revision ${revisionId} 没有关联 message。` };
  const sourceMessages = conversationMessages(world, sourceConversation);
  const cutoff = sourceMessages.indexOf(sourceMessage);
  if (cutoff < 0) return { ok: false, reason: `revision ${revisionId} 所属 message 不在 source conversation 中。` };
  const revisionData = world.get(revision, MessageRevision);
  for (const entity of sourceMessages.slice(0, cutoff + 1)) {
    const message = world.get(entity, Message);
    if (!message) continue;
    const overrideContent: MessageContent | undefined = entity === sourceMessage ? revisionData?.content : undefined;
    cloneMessageToConversation(cmd, targetConversation, message, overrideContent);
  }
  return { ok: true, revision };
}

function selectedMessagesForPolicy(world: WorldReader, sourceConversation: Entity, historyMode: ContextHistoryMode, args: NonNullable<RunAgentArgs['conversation']>): Entity[] {
  const messages = conversationMessages(world, sourceConversation);
  switch (historyMode) {
    case 'none': return [];
    case 'last_n': return messages.slice(-(args.lastN ?? 20));
    case 'selected_messages': {
      const ids = new Set(args.selectedMessageIds ?? []);
      return messages.filter((entity) => ids.has(world.get(entity, Message)?.id ?? ''));
    }
    case 'since_message': {
      const index = messages.findIndex((entity) => world.get(entity, Message)?.id === args.sinceMessageId);
      return index >= 0 ? messages.slice(index) : messages;
    }
    case 'summary':
    case 'full':
    default:
      return messages;
  }
}

function findReuseConversation(world: WorldReader, key: string, agent: Entity): Entity | undefined {
  const link = world
    .query(ConversationReuseLink)
    .map((entity) => world.get(entity, ConversationReuseLink))
    .find((candidate) => candidate?.key === key && (candidate.agent === undefined || candidate.agent === agent));
  return link?.conversation;
}

function ensureAgentConversationLink(world: WorldReader, cmd: CommandSink, agent: Entity, conversation: Entity, role: 'default' | 'participant' | 'reviewer'): void {
  const exists = world.query(AgentConversationLink).some((entity) => {
    const link = world.get(entity, AgentConversationLink);
    return !!link && link.agent === agent && link.conversation === conversation;
  });
  if (!exists) linkAgentToConversation(cmd, { agent, conversation, role });
}

function findConversationById(world: WorldReader, id: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === id);
}

function findRevisionById(world: WorldReader, id: string): Entity | undefined {
  return world.query(MessageRevision).find((entity) => world.get(entity, MessageRevision)?.id === id);
}

function normalizeConversationPolicyMode(mode: string | undefined): ConversationPolicyMode {
  switch (mode) {
    case 'same':
    case 'same_conversation': return 'same_conversation';
    case 'reuse':
    case 'reuse_conversation': return 'reuse_conversation';
    case 'fork':
    case 'fork_conversation': return 'fork_conversation';
    case 'branch':
    case 'branch_from_revision': return 'branch_from_revision';
    case 'fresh':
    case 'new':
    case 'new_conversation':
    default: return 'new_conversation';
  }
}

function normalizeHistoryMode(mode: string | undefined): ContextHistoryMode {
  switch (mode) {
    case 'none': return 'none';
    case 'last_n': return 'last_n';
    case 'selected':
    case 'selected_messages': return 'selected_messages';
    case 'since':
    case 'since_message': return 'since_message';
    case 'summary': return 'summary';
    case 'full':
    default: return 'full';
  }
}

function normalizeDeliveryMode(mode: string | undefined, background: boolean): DeliveryMode {
  switch (mode) {
    case 'append_to_source_conversation': return 'append_to_source_conversation';
    case 'silent': return 'silent';
    case 'notification': return 'notification';
    case 'tool_response': return 'tool_response';
    default: return background ? 'notification' : 'tool_response';
  }
}

function isAsyncDeliveryMode(mode: string | undefined): boolean {
  return mode === 'notification' || mode === 'append_to_source_conversation' || mode === 'silent';
}

function normalizeTranscript(value: string | undefined): TranscriptInclusion {
  switch (value) {
    case 'none': return 'none';
    case 'selected': return 'selected';
    case 'full': return 'full';
    case 'link': return 'link';
    case 'summary':
    default: return 'summary';
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'default';
}

function applyRunConversationPolicy(cmd: CommandSink, run: Entity, resolved: ResolvedConversation): void {
  const policy = cmd.spawn();
  cmd.add(policy, RunConversationPolicy, {
    id: `run-conversation-policy:${run}`,
    mode: resolved.policyMode,
    conversationId: resolved.explicitConversationId,
    reuseKey: resolved.reuseKey,
    branchFromRevisionId: resolved.branchFromRevisionId,
    visibility: resolved.visibility ?? 'collapsed'
  });
  const link = cmd.spawn();
  const now = Date.now();
  cmd.add(link, RunConversationPolicyLink, { id: `run-conversation-policy-link:${run}`, run, policy, role: 'active', createdAt: now, updatedAt: now });
}

function applyRunContextPolicy(cmd: CommandSink, run: Entity, args: RunAgentArgs, resolved: ResolvedConversation, defaultPolicy: RunContextPolicyBlueprint): void {
  const contextPolicy = resolveContextPolicy(args, resolved, defaultPolicy);
  const policy = cmd.spawn();
  cmd.add(policy, RunContextPolicy, {
    id: `run-context-policy:${run}`,
    ...contextPolicy
  });
  const link = cmd.spawn();
  const now = Date.now();
  cmd.add(link, RunContextPolicyLink, { id: `run-context-policy-link:${run}`, run, policy, role: 'active', createdAt: now, updatedAt: now });
}

function resolveContextPolicy(args: RunAgentArgs, resolved: ResolvedConversation, defaultPolicy: RunContextPolicyBlueprint): RunContextPolicyBlueprint {
  const shorthand = args.conversation;
  const hasShorthand = !!shorthand && (
    shorthand.history !== undefined
    || shorthand.lastN !== undefined
    || shorthand.sinceMessageId !== undefined
    || shorthand.selectedMessageIds !== undefined
    || shorthand.includeSourceContext !== undefined
    || shorthand.includeSourceToolResult !== undefined
  );
  const base = hasShorthand
    ? {
        historyMode: contextHistoryModeForResolvedConversation(resolved, args),
        lastN: shorthand?.lastN,
        sinceMessageId: shorthand?.sinceMessageId,
        selectedMessageIds: shorthand?.selectedMessageIds,
        includeSourceContext: shorthand?.includeSourceContext,
        includeSourceToolResult: shorthand?.includeSourceToolResult
      }
    : defaultPolicy;
  if (resolved.policyMode === 'fork_conversation' || resolved.policyMode === 'branch_from_revision') return { ...base, historyMode: 'full' };
  return { ...base, historyMode: base.historyMode ?? 'full' };
}

function contextHistoryModeForResolvedConversation(resolved: ResolvedConversation, args: RunAgentArgs): ContextHistoryMode {
  // fork/branch 已经在目标 conversation 中投影出所需历史；LLM 上下文应读取完整目标投影，
  // 避免 selected/since 使用源 message id 再过滤克隆后的 message 而丢失上下文。
  if (resolved.policyMode === 'fork_conversation' || resolved.policyMode === 'branch_from_revision') return 'full';
  return normalizeHistoryMode(args.conversation?.history);
}

function applyRunDeliveryPolicy(cmd: CommandSink, run: Entity, deliveryPolicy: RunDeliveryPolicyBlueprint): void {
  const policy = cmd.spawn();
  cmd.add(policy, RunDeliveryPolicy, { id: `run-delivery-policy:${run}`, ...deliveryPolicy });
  const link = cmd.spawn();
  const now = Date.now();
  cmd.add(link, RunDeliveryPolicyLink, { id: `run-delivery-policy-link:${run}`, run, policy, role: 'active', createdAt: now, updatedAt: now });
}

function applyRunEditPolicy(cmd: CommandSink, run: Entity, editPolicy: RunEditPolicyBlueprint): void {
  const policy = cmd.spawn();
  cmd.add(policy, RunEditPolicy, { id: `run-edit-policy:${run}`, ...editPolicy });
  const link = cmd.spawn();
  const now = Date.now();
  cmd.add(link, RunEditPolicyLink, { id: `run-edit-policy-link:${run}`, run, policy, role: 'active', createdAt: now, updatedAt: now });
}

function applyRunModeOverrides(world: WorldReader, cmd: CommandSink, run: Entity, mode?: RunAgentArgs['mode']): void {
  if (!mode) return;
  const now = Date.now();
  const modeEntity = mode.modeId ? findByRecordId(world, Mode, mode.modeId) : undefined;
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
  const contextPolicy = mode.contextPolicyId ? findByRecordId(world, RunContextPolicy, mode.contextPolicyId) : undefined;
  if (contextPolicy !== undefined) linkRunPolicy(cmd, RunContextPolicyLink, `run-context-policy:${run}:${mode.contextPolicyId}`, run, contextPolicy, now);

  const deliveryPolicy = mode.deliveryPolicyId ? findByRecordId(world, RunDeliveryPolicy, mode.deliveryPolicyId) : undefined;
  if (deliveryPolicy !== undefined) linkRunPolicy(cmd, RunDeliveryPolicyLink, `run-delivery-policy:${run}:${mode.deliveryPolicyId}`, run, deliveryPolicy, now);

  const editPolicy = mode.editPolicyId ? findByRecordId(world, RunEditPolicy, mode.editPolicyId) : undefined;
  if (editPolicy !== undefined) linkRunPolicy(cmd, RunEditPolicyLink, `run-edit-policy:${run}:${mode.editPolicyId}`, run, editPolicy, now);

  if (mode.contextPolicy) {
    const policy = cmd.spawn();
    cmd.add(policy, RunContextPolicy, {
      id: `run-context-policy-inline:${run}`,
      historyMode: normalizeHistoryMode(mode.contextPolicy.historyMode),
      lastN: mode.contextPolicy.lastN,
      sinceMessageId: mode.contextPolicy.sinceMessageId,
      selectedMessageIds: mode.contextPolicy.selectedMessageIds,
      includeSourceContext: mode.contextPolicy.includeSourceContext,
      includeSourceToolResult: mode.contextPolicy.includeSourceToolResult
    });
    linkRunPolicy(cmd, RunContextPolicyLink, `run-context-policy-inline-link:${run}`, run, policy, Date.now());
  }

  if (mode.deliveryPolicy) {
    const policy = cmd.spawn();
    cmd.add(policy, RunDeliveryPolicy, {
      id: `run-delivery-policy-inline:${run}`,
      mode: normalizeDeliveryMode(mode.deliveryPolicy.mode, false),
      includeTranscript: normalizeTranscript(mode.deliveryPolicy.includeTranscript)
    });
    linkRunPolicy(cmd, RunDeliveryPolicyLink, `run-delivery-policy-inline-link:${run}`, run, policy, Date.now());
  }

  if (mode.editPolicy) {
    const policy = cmd.spawn();
    cmd.add(policy, RunEditPolicy, {
      id: `run-edit-policy-inline:${run}`,
      onSourceEdited: normalizeSourceEditBehavior(mode.editPolicy.onSourceEdited),
      onNewUserMessageWhileRunning: normalizeNewMessageWhileRunningBehavior(mode.editPolicy.onNewUserMessageWhileRunning)
    });
    linkRunPolicy(cmd, RunEditPolicyLink, `run-edit-policy-inline-link:${run}`, run, policy, Date.now());
  }
}

function linkRunPolicy<T>(
  cmd: CommandSink,
  component: { id: symbol },
  id: string,
  run: Entity,
  policy: Entity,
  now: number
): void {
  const link = cmd.spawn();
  cmd.add(link, component as never, { id, run, policy, role: 'active', createdAt: now, updatedAt: now } as never);
}

function normalizeSourceEditBehavior(value: string | undefined): SourceEditBehavior {
  switch (value) {
    case 'ignore_snapshot': return 'ignore_snapshot';
    case 'abort_and_restart': return 'abort_and_restart';
    case 'append_correction': return 'append_correction';
    case 'branch_new_run': return 'branch_new_run';
    case 'mark_stale':
    default: return 'mark_stale';
  }
}

function normalizeNewMessageWhileRunningBehavior(value: string | undefined): NewMessageWhileRunningBehavior {
  switch (value) {
    case 'interrupt_current': return 'interrupt_current';
    case 'append_to_target': return 'append_to_target';
    case 'ignore': return 'ignore';
    case 'queue_next_run':
    default: return 'queue_next_run';
  }
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: { id: symbol }, id: string): Entity | undefined {
  return world.query(component as never).find((entity) => (world.get(entity, component as never) as T | undefined)?.id === id);
}

function dispatchApprovedAwaitingCalls(world: WorldReader, cmd: CommandSink, handled: Set<Entity>): void {
  const approvedCalls = world
    .query(ToolCall, ToolState)
    .filter((entity) => {
      const state = world.get(entity, ToolState);
      return !handled.has(entity)
        && !world.has(entity, InFlight)
        && state?.status === 'awaiting_approval'
        && isExecutionApproved(state);
    })
    .sort((left, right) => compareToolCallOrder(world, left, right));

  for (const entity of approvedCalls) {
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);
    if (!call || !state) continue;
    const authorization = authorizeRunToolExecution(world, entity, call);
    if (!authorization.ok) {
      rejectToolCall(cmd, entity, call, state, authorization.reason);
      handled.add(entity);
      continue;
    }
    if (!isRunReadyForToolExecution(authorization)) continue;
    if (!isInActiveExecutionBatch(world, authorization.run, entity)) {
      continue;
    }
    dispatchToolCall(world, cmd, entity, call, state, authorization);
    handled.add(entity);
  }
}

function markExecutionApproved(
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  state: ToolStateData,
  authorization: Extract<AuthorizationResult, { ok: true }>,
  waitingForPrevious: boolean
): void {
  const now = Date.now();
  const progress = {
    ...progressRecord(state.progress),
    executionApproved: true,
    waitingForPrevious
  };
  cmd.add(entity, ToolState, { ...state, status: 'awaiting_approval', progress, updatedAt: now });
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'state',
    status: 'awaiting_approval',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    payload: { executorAgentId: authorization.agentId, runId: authorization.runId, approved: true, waitingForPrevious }
  });
}

function findAgentById(world: WorldReader, id: string): Entity | undefined {
  return world.query(Agent).find((agent) => world.get(agent, Agent)?.id === id);
}

function findAgentByKind(world: WorldReader, kind: string): Entity | undefined {
  return world.query(Agent).find((agent) => world.get(agent, Agent)?.id === kind || world.get(agent, Agent)?.name === kind);
}

function isAgentRunTool(world: WorldReader, toolName: string): boolean {
  return (world.tryGetResource(ToolDefinitionsKey) ?? []).some((tool) => tool.name === toolName && tool.execution === 'agentRun');
}

function effectiveToolConfig(world: WorldReader, policy: ToolPolicyData, toolName: string): ToolConfigRecord | undefined {
  const definition = (world.tryGetResource(ToolDefinitionsKey) ?? []).find((tool) => tool.name === toolName);
  const config = {
    ...(definition?.defaultConfig ?? {}),
    ...(policy.toolConfigs?.[toolName]?.config ?? {})
  } satisfies ToolConfigRecord;
  return Object.keys(config).length > 0 ? config : undefined;
}

function toolGateSettings(policy: ToolPolicyData, toolName: string): { autoApproveExecution: boolean; autoApplyResult: boolean } {
  const config = policy.toolConfigs?.[toolName];
  return {
    autoApproveExecution: config?.autoApproveExecution ?? true,
    autoApplyResult: config?.autoApplyResult ?? true
  };
}

function requiresExecutionApproval(toolPolicy: ToolPolicyData, toolName: string): boolean {
  return toolGateSettings(toolPolicy, toolName).autoApproveExecution === false;
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
