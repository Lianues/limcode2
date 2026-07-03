import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent, AgentConversationLink, AgentKind, type AgentData } from '../../agent/components';
import { agentSelectorSlug, findAgentTypeEntity, isTemporaryAgentEntity } from '../../agent/identity';
import {
  AgentBlueprintsKey,
  type BuiltinAgentDefinition,
  type BuiltinAgentRegistry,
  type BuiltinModeDefinition
} from '../../agent/blueprints';
import { AgentFromBlueprintBundle, linkAgentToConversation, selectAgentForConversation, spawnAgentRuntimeMirror } from '../../agent/bundles';
import { Conversation, ConversationBranchLink, ConversationOriginLink, ConversationReuseLink, InFlight, Message, MessageRevision, PartOf } from '../../chat/components';
import {
  cloneMessageToConversation,
  ConversationBundle,
  ConversationLinkBundle,
  MessageBundle,
  spawnConversation,
  spawnConversationBranchLink,
  spawnConversationOriginLink,
  spawnConversationReuseLink,
  spawnUserMessage
} from '../../chat/bundles';
import { conversationMessages } from '../../chat/queries';
import {
  ConversationModeSelection,
  Mode,
  ToolPolicy,
  type ToolPolicyData
} from '../../mode/components';
import { ModeBundle, selectGlobalModeForConversation } from '../../mode/bundles';
import {
  AgentRun,
  AgentRunSourceLink,
  AgentRunTargetLink,
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
  ToolCallRunLink
} from '../../agentRun/components';
import { AgentRunBundle, spawnAgentRun } from '../../agentRun/bundles';
import { activeToolPolicyForRun, runForToolCall, runSource, runTarget, toolCallEntityById } from '../../agentRun/queries';
import { AgentAnswerBundle, spawnAgentAnswer } from '../../agentAnswer/bundles';
import { AgentAnswer, AgentAnswerSubmissionLink, AgentAnswerTargetLink } from '../../agentAnswer/components';
import { agentAnswerById } from '../../agentAnswer/queries';
import { LlmInvocation, RunLlmInvocationLink } from '../../llm/components';
import { ToolCallEventBundle, spawnToolCallEvent } from '../bundles';
import { ToolCall, ToolPolicyScopeLink, ToolResultConsumed, ToolState, type ToolCallData, type ToolStateData } from '../components';
import { ToolEventType } from '../events';
import { transitionToolState } from '../state';
import {
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink,
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink
} from '../../workEnvironment/components';
import { ConversationProjectLink, ProjectContext } from '../../project/components';
import { CheckpointEventType } from '../../checkpoint/events';
import { ConversationProjectLinkBundle } from '../../project/bundles';
import { CheckpointBarrier, type CheckpointBarrierData } from '../../checkpoint/components';
import {
  activeWorkEnvironmentForRun,
  effectiveWorkEnvironmentPolicyForRun,
  pathAccessibleWorkEnvironmentsForRun,
  resolveWorkEnvironmentBySelector,
  toPublicWorkEnvironmentRecord,
  toolContextWorkEnvironmentsForRun
} from '../../workEnvironment/queries';
import {
  selectConversationWorkEnvironment,
  selectRunWorkEnvironment,
  WorkEnvironmentBundle
} from '../../workEnvironment/bundles';
import { ToolDefinitionsKey, ToolRuntimeDefinitionsKey, ToolSchemasKey } from '../resources';
import { isToolAllowedByPolicy, isYoloToolPolicy } from '../policy';
import { spawnCheckpointBarrier, consumeReleasedCheckpointBarrier, newestBarrierForTarget } from '../../checkpoint/barriers';
import { effectiveCheckpointPolicyForRequest } from '../../checkpoint/queries';
import { effectiveCheckpointToolTriggerConfig } from '../../checkpoint/policy';
import { isReadonlyCommandCall } from '../definitions/command';
import { allowOutsideProjectPathsFromConfig } from '../definitions/filePathPolicy';
import { RUN_AGENT_TOOL_NAME } from '../definitions/runAgent';
import {
  compareToolCallOrder,
  isExecutionApproved,
  isInActiveExecutionBatch,
  progressRecord
} from '../scheduling';
import {
  createMessageId,
  SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  TRANSFER_TOOL_NAME,
  READ_AGENT_ANSWER_TOOL_NAME,
  SUBMIT_AGENT_ANSWER_TOOL_NAME,
  type AgentRunStatus,
  type ContextHistoryMode,
  type ConversationPolicyMode,
  type ConversationVisibility,
  type DeliveryMode,
  type LlmInvocationSettingsSnapshotRecord,
  type MessageContent,
  type NewMessageWhileRunningBehavior,
  type SourceEditBehavior,
  type ToolConfigRecord,
  type TranscriptInclusion
} from '../../../../../shared/protocol';
import type { FsPendingFileChangeProposal } from '../../../../capabilities/types';

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
    ConversationOriginLink,
    Message,
    MessageRevision,
    Agent,
    AgentConversationLink,
    ConversationModeSelection,
    Mode,
    ToolPolicy,
    ToolPolicyScopeLink,
    AgentRun,
    AgentRunSourceLink,
    ToolCallRunLink,
    AgentRunTargetLink,
    AgentAnswer,
    AgentAnswerSubmissionLink,
    AgentAnswerTargetLink,
    ToolResultConsumed,
    CheckpointBarrier,
    ProjectContext,
    ConversationProjectLink,
    WorkEnvironment,
    WorkEnvironmentPolicy,
    WorkEnvironmentPolicyScopeLink,
    ConversationWorkEnvironmentLink,
    RunWorkEnvironmentLink,
    RunDeliveryPolicy,
    RunDeliveryPolicyLink,
    LlmInvocation,
    RunLlmInvocationLink
  ],
  write: [ToolState, AgentRun, AgentAnswer, RunDeliveryPolicy],
  remove: [InFlight],
  add: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

export const ToolDispatchSystem = defineSystem({
  name: 'ToolDispatchSystem',
  access: {
    queries: [QueuedToolCallsQuery],
    writes: { components: [CheckpointBarrier] },
    resources: { read: [AgentBlueprintsKey, ToolSchemasKey, ToolDefinitionsKey, ToolRuntimeDefinitionsKey] },
    bundles: [ToolCallEventBundle, ConversationBundle, ConversationLinkBundle, MessageBundle, AgentRunBundle, AgentAnswerBundle, AgentFromBlueprintBundle, ModeBundle, ConversationProjectLinkBundle, WorkEnvironmentBundle],
    events: { read: [ToolEventType.ExecutionApproveRequested, ToolEventType.ExecutionRejectRequested, ToolEventType.ChangeApplyRequested, ToolEventType.ChangeRejectRequested], emit: [CheckpointEventType.Requested] },
    effects: { emit: ['tool.run', 'tool.change.apply'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    backgroundTimedOutRunAgentTools(world, cmd);

    const handled = new Set<Entity>();

    for (const request of readEvents(ctx, ToolEventType.ChangeRejectRequested)) {
      const entity = toolCallEntityById(world, request.toolCallId);
      if (entity === undefined || handled.has(entity)) continue;
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state || state.status !== 'awaiting_change_apply') continue;
      handled.add(entity);
      rejectToolCall(cmd, entity, call, state, request.reason?.trim() || '用户拒绝应用更改。');
    }

    for (const request of readEvents(ctx, ToolEventType.ChangeApplyRequested)) {
      const entity = toolCallEntityById(world, request.toolCallId);
      if (entity === undefined || handled.has(entity)) continue;
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state || state.status !== 'awaiting_change_apply' || world.has(entity, InFlight)) continue;
      handled.add(entity);

      const authorization = authorizeRunToolExecution(world, entity, call);
      if (!authorization.ok) {
        rejectToolCall(cmd, entity, call, state, authorization.reason);
        continue;
      }
      const proposal = pendingFileChangeProposal(state.result);
      if (!proposal) {
        rejectToolCall(cmd, entity, call, state, '工具结果缺少可应用的文件变更提案。');
        continue;
      }
      applyPendingToolChange(world, cmd, entity, call, state, authorization, proposal);
    }

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
      markExecutionApproved(cmd, entity, call, state, authorization, false);
      dispatchToolCall(world, cmd, entity, call, state, authorization);
    }

    dispatchApprovedAwaitingCalls(world, cmd, handled);
    autoApplyYoloAwaitingChanges(world, cmd, handled);

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

      if (requiresExecutionApproval(world, authorization.policy, call)) {
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
  const definition = (world.tryGetResource(ToolDefinitionsKey) ?? []).find((tool) => tool.name === call.name);
  if (!definition || !isToolAllowedByPolicy(policy, definition)) {
    return { ok: false, reason: `AgentRun ${runData.id} 不允许执行工具 ${call.name}。` };
  }
  if ((call.name === SWITCH_WORK_ENVIRONMENT_TOOL_NAME || call.name === TRANSFER_TOOL_NAME) && effectiveWorkEnvironmentPolicyForRun(world, run).policy?.enabled === false) {
    return { ok: false, reason: `当前工作环境策略已停用工具 ${call.name}。` };
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
  if (awaitToolExecutionBeforeCheckpoint(world, cmd, entity, call, authorization)) return;
  if (call.name === SUBMIT_AGENT_ANSWER_TOOL_NAME) {
    executeSubmitAgentAnswerTool(world, cmd, entity, call, state, authorization);
    return;
  }
  if (call.name === READ_AGENT_ANSWER_TOOL_NAME) {
    executeReadAgentAnswerTool(world, cmd, entity, call, state, authorization);
    return;
  }
  if (call.name === SWITCH_WORK_ENVIRONMENT_TOOL_NAME) {
    executeSwitchWorkEnvironmentTool(world, cmd, entity, call, state, authorization);
    return;
  }
  if (isAgentRunTool(world, call.name)) {
    executeRunAgentTool(world, cmd, entity, call, state, authorization);
    return;
  }
  executeRuntimeToolCall(world, cmd, entity, call, state, authorization);
}

function awaitToolExecutionBeforeCheckpoint(
  world: WorldReader,
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  authorization: Extract<AuthorizationResult, { ok: true }>
): boolean {
  const existing = newestBarrierForTarget(world, (barrier) => toolExecutionBarrierMatches(barrier, entity, call.id));
  if (existing) {
    if (existing.barrier.status === 'released') {
      consumeReleasedCheckpointBarrier(cmd, existing.entity);
      return false;
    }
    return true;
  }

  if (!toolExecutionBeforeCheckpointEnabled(world, authorization, call)) return false;

  const target = runTarget(world, authorization.run);
  if (!target) return false;
  const checkpointId = createMessageId();
  spawnCheckpointBarrier(cmd, {
    checkpointId,
    conversation: target.conversation,
    trigger: 'tool_execution_before',
    targetKind: 'tool_execution',
    targetRun: authorization.run,
    targetRunId: authorization.runId,
    targetToolCall: entity,
    targetToolCallId: call.id
  });
  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: {
      checkpointId,
      conversationId: authorization.conversationId,
      runId: authorization.runId,
      toolCallId: call.id,
      toolName: call.name,
      anchorPosition: 'before',
      trigger: 'tool_execution_before'
    }
  });
  return true;
}

function toolExecutionBarrierMatches(barrier: CheckpointBarrierData, entity: Entity, toolCallId: string): boolean {
  return barrier.trigger === 'tool_execution_before'
    && barrier.targetKind === 'tool_execution'
    && (barrier.targetToolCall === entity || barrier.targetToolCallId === toolCallId);
}

function toolExecutionBeforeCheckpointEnabled(world: WorldReader, authorization: Extract<AuthorizationResult, { ok: true }>, call: ToolCallData): boolean {
  if (isYoloToolPolicy(authorization.policy)) return false;
  const target = runTarget(world, authorization.run);
  if (!target) return false;
  const resolution = effectiveCheckpointPolicyForRequest(world, { conversation: target.conversation, run: authorization.run });
  if (!resolution.policy.enabled) return false;
  const toolDefinition = (world.tryGetResource(ToolDefinitionsKey) ?? []).find((tool) => tool.name === call.name);
  return effectiveCheckpointToolTriggerConfig(call.name, resolution.policy.toolTriggers, toolDefinition).before;
}

function executeRuntimeToolCall(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  const workEnvironment = activeWorkEnvironmentForRun(world, authorization.run)?.data;
  const workEnvironments = toolContextWorkEnvironmentsForRun(world, authorization.run).map((item) => toPublicWorkEnvironmentRecord(item.data));
  const accessibleWorkEnvironments = pathAccessibleWorkEnvironmentsForRun(world, authorization.run).map((item) => toPublicWorkEnvironmentRecord(item.data));
  const settingsSnapshot = settingsSnapshotForRun(world, authorization.run);
  cmd.effect({
    kind: 'tool.run',
    toolCallId: call.id,
    name: call.name,
    argsJson: call.argsJson,
    runId: authorization.runId,
    conversationId: authorization.conversationId,
    config: effectiveToolConfig(world, authorization.policy, call.name),
    ...(settingsSnapshot ? { settingsSnapshot } : {}),
    ...(workEnvironment ? { workEnvironment: toPublicWorkEnvironmentRecord(workEnvironment) } : {}),
    ...(workEnvironments.length > 0 ? { workEnvironments } : {}),
    ...(accessibleWorkEnvironments.length > 0 ? { accessibleWorkEnvironments } : {})
  });
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

function settingsSnapshotForRun(world: WorldReader, run: Entity): LlmInvocationSettingsSnapshotRecord | undefined {
  let latest: { settings: LlmInvocationSettingsSnapshotRecord; invocationCreatedAt: number; linkCreatedAt: number; linkId: string } | undefined;
  for (const entity of world.query(RunLlmInvocationLink)) {
    const link = world.get(entity, RunLlmInvocationLink);
    if (!link || link.run !== run) continue;
    const invocation = world.get(link.invocation, LlmInvocation);
    if (!invocation?.settings) continue;
    const candidate = {
      settings: invocation.settings,
      invocationCreatedAt: invocation.createdAt,
      linkCreatedAt: link.createdAt,
      linkId: link.id
    };
    if (!latest
      || candidate.invocationCreatedAt > latest.invocationCreatedAt
      || (candidate.invocationCreatedAt === latest.invocationCreatedAt && candidate.linkCreatedAt > latest.linkCreatedAt)
      || (candidate.invocationCreatedAt === latest.invocationCreatedAt && candidate.linkCreatedAt === latest.linkCreatedAt && candidate.linkId > latest.linkId)
    ) {
      latest = candidate;
    }
  }
  return latest?.settings;
}

interface SubmitAgentAnswerArgs {
  answerBridgeId?: string;
  title?: string;
  content?: string;
}

interface ReadAgentAnswerArgs {
  answerBridgeId?: string;
}

function executeSubmitAgentAnswerTool(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  let args: SubmitAgentAnswerArgs = {};
  try {
    args = call.argsJson ? JSON.parse(call.argsJson) as SubmitAgentAnswerArgs : {};
  } catch (error) {
    rejectToolCall(cmd, entity, call, state, `submit_agent_answer 参数不是合法 JSON: ${String(error)}`);
    return;
  }

  const title = args.title?.trim();
  const content = typeof args.content === 'string' ? args.content : '';
  if (!title) {
    rejectToolCall(cmd, entity, call, state, 'submit_agent_answer 缺少必填 title。');
    return;
  }
  if (!content.trim()) {
    rejectToolCall(cmd, entity, call, state, 'submit_agent_answer 缺少必填 content。');
    return;
  }

  const explicitAnswerBridgeId = args.answerBridgeId?.trim();
  const source = runSource(world, authorization.run);
  const answerBridgeId = explicitAnswerBridgeId || source?.answerBridgeId?.trim();
  if (!answerBridgeId) {
    rejectToolCall(cmd, entity, call, state, 'submit_agent_answer 缺少 answerBridgeId，且当前 AgentRun 没有默认 answerBridgeId。');
    return;
  }

  const submitterTarget = runTarget(world, authorization.run);
  const parentTarget = source?.sourceRun !== undefined ? runTarget(world, source.sourceRun) : undefined;
  const targetAgent = source?.sourceAgent ?? parentTarget?.agent;
  const targetConversation = source?.sourceConversation ?? parentTarget?.conversation;

  if (answerBridgeId) {
    const existingAnswer = agentAnswerById(world, answerBridgeId);
    const existingAnswerData = existingAnswer !== undefined ? world.get(existingAnswer, AgentAnswer) : undefined;
    if (existingAnswer !== undefined && existingAnswerData) {
      const now = Date.now();
      cmd.add(existingAnswer, AgentAnswer, { ...existingAnswerData, title, content, updatedAt: now });
      completeInlineToolCallSuccess(cmd, entity, call, state, { ok: true, answerBridgeId, updated: true });
      return;
    }
  }

  const spawned = spawnAgentAnswer(cmd, {
    id: answerBridgeId,
    title,
    content,
    submission: {
      submitterRun: authorization.run,
      submitterRunId: authorization.runId,
      ...(submitterTarget?.agent !== undefined ? { submitterAgent: submitterTarget.agent } : {}),
      ...optionalRecordId('submitterAgentId', submitterTarget?.agent !== undefined ? world.get(submitterTarget.agent, Agent)?.id : undefined),
      ...(submitterTarget?.conversation !== undefined ? { submitterConversation: submitterTarget.conversation } : {}),
      ...optionalRecordId('submitterConversationId', submitterTarget?.conversation !== undefined ? world.get(submitterTarget.conversation, Conversation)?.id : undefined),
      submitterToolCall: entity,
      submitterToolCallId: call.id
    },
    target: {
      ...(source?.sourceRun !== undefined ? { targetRun: source.sourceRun } : {}),
      ...optionalRecordId('targetRunId', source?.sourceRun !== undefined ? world.get(source.sourceRun, AgentRun)?.id : undefined),
      ...(targetAgent !== undefined ? { targetAgent } : {}),
      ...optionalRecordId('targetAgentId', targetAgent !== undefined ? world.get(targetAgent, Agent)?.id : undefined),
      ...(targetConversation !== undefined ? { targetConversation } : {}),
      ...optionalRecordId('targetConversationId', targetConversation !== undefined ? world.get(targetConversation, Conversation)?.id : undefined),
      ...(source?.sourceToolCall !== undefined ? { sourceToolCall: source.sourceToolCall } : {}),
      ...optionalRecordId('sourceToolCallId', source?.sourceToolCall !== undefined ? world.get(source.sourceToolCall, ToolCall)?.id : undefined)
    }
  });

  completeInlineToolCallSuccess(cmd, entity, call, state, { ok: true, answerBridgeId: spawned.id });
}

function executeReadAgentAnswerTool(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, _authorization: Extract<AuthorizationResult, { ok: true }>): void {
  let args: ReadAgentAnswerArgs = {};
  try {
    args = call.argsJson ? JSON.parse(call.argsJson) as ReadAgentAnswerArgs : {};
  } catch (error) {
    rejectToolCall(cmd, entity, call, state, `read_agent_answer 参数不是合法 JSON: ${String(error)}`);
    return;
  }

  const answerBridgeId = args.answerBridgeId?.trim();
  if (!answerBridgeId) {
    rejectToolCall(cmd, entity, call, state, 'read_agent_answer 缺少必填 answerBridgeId。');
    return;
  }

  const answerEntity = agentAnswerById(world, answerBridgeId);
  const answer = answerEntity !== undefined ? world.get(answerEntity, AgentAnswer) : undefined;
  if (answerEntity === undefined || !answer) {
    completeInlineToolCallSuccess(cmd, entity, call, state, { ok: false, answerBridgeId, error: `AgentAnswer not found: ${answerBridgeId}` });
    return;
  }

  completeInlineToolCallSuccess(cmd, entity, call, state, {
    ok: true,
    answerBridgeId: answer.id,
    title: answer.title,
    content: answer.content
  });
}

function backgroundTimedOutRunAgentTools(world: WorldReader, cmd: CommandSink): void {
  const now = Date.now();
  for (const entity of world.query(ToolCall, ToolState)) {
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);
    if (!call || !state || call.name !== RUN_AGENT_TOOL_NAME || state.status !== 'executing') continue;
    const progress = runAgentToolProgress(state.progress);
    const timeoutMs = progress.timeoutMs;
    const startedAt = progress.startedAt ?? call.createdAt;
    if (timeoutMs === undefined || timeoutMs <= 0) continue;
    if (now - startedAt < timeoutMs) continue;

    const run = progress.runId ? findAgentRunById(world, progress.runId) : undefined;
    if (run !== undefined) setRunDeliveryPolicyMode(world, cmd, run, 'notification');
    completeRunAgentToolAsBackground(cmd, entity, call, state, progress, 'timeout');
  }
}

function runAgentToolProgress(value: unknown): RunAgentToolProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    childRunId: typeof record.childRunId === 'string' ? record.childRunId : undefined,
    runId: typeof record.runId === 'string' ? record.runId : undefined,
    agentId: typeof record.agentId === 'string' ? record.agentId : undefined,
    conversationId: typeof record.conversationId === 'string' ? record.conversationId : undefined,
    answerBridgeId: typeof record.answerBridgeId === 'string' ? record.answerBridgeId : undefined,
    timeoutMs: typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs) ? record.timeoutMs : undefined,
    startedAt: typeof record.startedAt === 'number' && Number.isFinite(record.startedAt) ? record.startedAt : undefined
  };
}

function completeRunAgentToolAsBackground(
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  state: ToolStateData,
  progress: RunAgentToolProgress,
  reason: 'timeout' | 'timeout_zero'
): void {
  const started = state.status === 'executing'
    ? { state, startedAt: progress.startedAt ?? call.createdAt }
    : startInlineToolExecution(cmd, entity, call, state, progress);
  const now = Date.now();
  const durationMs = Math.max(0, now - started.startedAt);
  const result = {
    ok: true,
    status: 'backgrounded',
    reason,
    ...(progress.agentId ? { agentId: progress.agentId } : {}),
    ...(progress.runId ? { runId: progress.runId } : {}),
    ...(progress.conversationId ? { conversationId: progress.conversationId } : {}),
    ...(progress.answerBridgeId ? { answerBridgeId: progress.answerBridgeId } : {}),
    message: reason === 'timeout_zero'
      ? 'AgentRun 已直接转入后台执行；稍后可用 answerBridgeId 读取提交内容。'
      : 'AgentRun 超过 timeout，已转入后台继续执行；稍后可用 answerBridgeId 读取提交内容。'
  };
  cmd.add(entity, ToolState, transitionToolState(started.state, 'success', { result, durationMs }, now));
  cmd.remove(entity, InFlight);
  spawnToolCallEvent(cmd, { toolCall: entity, toolCallId: call.id, kind: 'completed', status: 'success', at: now, elapsedMs: Math.max(0, now - call.createdAt), durationMs, payload: result });
}

function setRunDeliveryPolicyMode(world: WorldReader, cmd: CommandSink, run: Entity, mode: DeliveryMode): void {
  const link = world.query(RunDeliveryPolicyLink)
    .map((entity) => world.get(entity, RunDeliveryPolicyLink))
    .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate && candidate.run === run && candidate.role === 'active')
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
  const policy = link ? world.get(link.policy, RunDeliveryPolicy) : undefined;
  if (!link || !policy) {
    applyRunDeliveryPolicy(cmd, run, { mode, includeTranscript: 'summary' });
    return;
  }
  cmd.add(link.policy, RunDeliveryPolicy, { ...policy, mode, includeTranscript: policy.includeTranscript ?? 'summary' });
}

function optionalRecordId<TKey extends string>(key: TKey, value: string | undefined): { [K in TKey]?: string } {
  const id = value?.trim();
  return id ? { [key]: id } as { [K in TKey]?: string } : {};
}

function completeInlineToolCallSuccess(cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, result: unknown): void {
  const started = startInlineToolExecution(cmd, entity, call, state);
  const now = Date.now();
  const durationMs = Math.max(0, now - started.startedAt);
  cmd.add(entity, ToolState, transitionToolState(started.state, 'success', { result, durationMs }, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'completed',
    status: 'success',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    durationMs,
    payload: result
  });
}



interface SwitchWorkEnvironmentArgs {
  workEnvironmentId?: string;
}

function executeSwitchWorkEnvironmentTool(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  let args: SwitchWorkEnvironmentArgs = {};
  try {
    args = call.argsJson ? JSON.parse(call.argsJson) as SwitchWorkEnvironmentArgs : {};
  } catch (error) {
    rejectToolCall(cmd, entity, call, state, `switch_work_environment 参数不是合法 JSON: ${String(error)}`);
    return;
  }
  const workEnvironmentId = args.workEnvironmentId?.trim();
  if (!workEnvironmentId) {
    rejectToolCall(cmd, entity, call, state, 'switch_work_environment 缺少必填 workEnvironmentId。');
    return;
  }

  const target = resolveWorkEnvironmentBySelector(world, {
    workEnvironmentId
  }, { run: authorization.run });
  if (!target) {
    rejectToolCall(cmd, entity, call, state, `未找到或当前策略不允许使用工作环境：${workEnvironmentId}`);
    return;
  }

  const runTargetInfo = runTarget(world, authorization.run);
  if (!runTargetInfo) {
    rejectToolCall(cmd, entity, call, state, '无法解析当前 AgentRun 的目标对话，不能切换工作环境。');
    return;
  }

  const started = startInlineToolExecution(cmd, entity, call, state, {
    executorAgentId: authorization.agentId,
    runId: authorization.runId,
    workEnvironmentId: target.data.id
  });

  selectRunWorkEnvironment(world, cmd, authorization.run, target.entity);
  selectConversationWorkEnvironment(world, cmd, runTargetInfo.conversation, target.entity);

  const record = toPublicWorkEnvironmentRecord(target.data);
  const now = Date.now();
  const durationMs = Math.max(0, now - started.startedAt);
  const result = {
    ok: true,
    kind: 'work_environment.switch',
    workEnvironment: record,
    message: `已切换到工作环境：${record.name}`
  };
  cmd.add(entity, ToolState, transitionToolState(started.state, 'success', { result, durationMs }, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'completed',
    status: 'success',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    durationMs,
    payload: result
  });
}

interface RunAgentArgs {
  prompt?: string;
  agent?: {
    id?: string;
    type?: string;
  };
  timeout?: number;
  wait?: string;
  scheduling?: string;
}

interface RunAgentToolProgress {
  childRunId?: string;
  runId?: string;
  agentId?: string;
  conversationId?: string;
  answerBridgeId?: string;
  timeoutMs?: number;
  startedAt?: number;
}

interface ResolvedConversation {
  conversation: Entity;
  conversationId: string;
  policyMode: ConversationPolicyMode;
  created?: boolean;
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


interface RunConversationPolicyBlueprint {
  mode: ConversationPolicyMode;
  visibility?: ConversationVisibility;
  reuseKey?: string;
  conversationId?: string;
}

interface RunContextPolicyBlueprint {
  historyMode: ContextHistoryMode;
  lastN?: number;
  sinceMessageId?: string;
  selectedMessageIds?: string[];
  includeSourceContext?: boolean;
  includeSourceToolResult?: boolean;
}

interface RunDeliveryPolicyBlueprint {
  mode: DeliveryMode;
  includeTranscript: TranscriptInclusion;
}

interface RunEditPolicyBlueprint {
  onSourceEdited: SourceEditBehavior;
  onNewUserMessageWhileRunning: NewMessageWhileRunningBehavior;
}

function resolveTargetModeBlueprint(modes: Record<string, BuiltinModeDefinition>, modeId: string | undefined): BuiltinModeDefinition | undefined {
  if (!modeId) return undefined;
  return modes[modeId] ?? Object.values(modes).find((mode) => mode.id === modeId || modeId.endsWith(`:mode:${mode.id}`));
}

function resolveRunAgentPolicyDefaults(_definition: BuiltinAgentDefinition, _mode: BuiltinModeDefinition | undefined): ResolvedRunAgentPolicyDefaults {
  return {
    conversationPolicy: { mode: 'new_conversation', visibility: 'collapsed' },
    contextPolicy: { historyMode: 'full' },
    deliveryPolicy: { mode: 'tool_response', includeTranscript: 'summary' },
    editPolicy: { onSourceEdited: 'mark_stale', onNewUserMessageWhileRunning: 'queue_next_run' }
  };
}

function normalizeRunAgentTimeout(value: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { ok: false, reason: 'run_agent.timeout 为必填参数，需为非负毫秒数；0 表示直接转后台。' };
  }
  return { ok: true, value: Math.floor(value) };
}

interface ResolvedRunAgentTarget {
  targetAgent: Entity;
  targetAgentId: string;
  definition: BuiltinAgentDefinition;
  resolved: { ok: true; value: ResolvedConversation } | { ok: false; reason: string };
}

function resolveRunAgentTarget(
  world: WorldReader,
  cmd: CommandSink,
  input: {
    blueprints: BuiltinAgentRegistry;
    requestedAgentId?: string;
    requestedKind: string;
    sourceConversation: Entity;
    toolCallEntity: Entity;
    prompt: string;
  }
): { ok: true; value: ResolvedRunAgentTarget } | { ok: false; reason: string } {
  if (input.requestedAgentId) {
    const existingAgent = findAgentById(world, input.requestedAgentId);
    if (existingAgent === undefined) return { ok: false, reason: `指定临时 Agent 镜像不存在: ${input.requestedAgentId}` };
    const agentData = world.get(existingAgent, Agent);
    if (!agentData) return { ok: false, reason: `指定临时 Agent 镜像数据不完整: ${input.requestedAgentId}` };
    if (!isTemporaryAgentEntity(world, existingAgent)) {
      return { ok: false, reason: `agent.id 只用于复用 run_agent 已创建的临时 Agent 镜像，不能直接传 Agent 类型配置 id: ${input.requestedAgentId}。新开镜像请传 agent.type。` };
    }
    const kind = world.get(existingAgent, AgentKind)?.kind || input.requestedKind;
    const definition = resolveAgentDefinition(input.blueprints, kind) ?? definitionFromExistingAgent(agentData, kind);
    return {
      ok: true,
      value: {
        targetAgent: existingAgent,
        targetAgentId: agentData.id,
        definition,
        resolved: resolveRunAgentConversation(world, cmd, {
          sourceConversation: input.sourceConversation,
          targetAgent: existingAgent,
          targetAgentId: agentData.id,
          kind,
          toolCallEntity: input.toolCallEntity,
          prompt: input.prompt,
          appendToExistingAgent: true
        })
      }
    };
  }

  const resolvedType = resolveAgentType(world, input.blueprints, input.requestedKind);
  if (!resolvedType) return { ok: false, reason: `未知 Agent 类型: ${input.requestedKind}。可用类型：${availableAgentTypes(world, input.blueprints).join(', ')}` };
  const { definition, typeAgentData, typeId } = resolvedType;
  const targetAgentId = createRunAgentAgentId(world, typeId);
  const targetAgent = spawnAgentRuntimeMirror(cmd, {
    mirrorAgentId: targetAgentId,
    typeAgentId: typeId,
    name: typeAgentData?.name ?? definition.name,
    description: typeAgentData?.description ?? definition.description,
    source: typeAgentData?.source ?? 'builtin'
  });
  const targetKind = typeId;
  return {
    ok: true,
    value: {
      targetAgent,
      targetAgentId,
      definition,
      resolved: resolveRunAgentConversation(world, cmd, {
        sourceConversation: input.sourceConversation,
        targetAgent,
        targetAgentId,
        kind: targetKind,
        toolCallEntity: input.toolCallEntity,
        prompt: input.prompt,
        appendToExistingAgent: false
      })
    }
  };
}

function resolveAgentDefinition(blueprints: BuiltinAgentRegistry, kind: string): BuiltinAgentDefinition | undefined {
  return blueprints.agents[kind]
    ?? Object.values(blueprints.agents).find((candidate) => candidate.kind === kind || candidate.id === kind);
}

function resolveAgentType(world: WorldReader, blueprints: BuiltinAgentRegistry, selector: string): { definition: BuiltinAgentDefinition; typeId: string; typeAgent?: Entity; typeAgentData?: AgentData } | undefined {
  const configured = findAgentTypeBySelector(world, selector);
  if (configured !== undefined) {
    const agent = world.get(configured, Agent);
    if (!agent) return undefined;
    const declaredKind = world.get(configured, AgentKind)?.kind || agent.id;
    const typeId = agent.id;
    return {
      definition: resolveAgentDefinition(blueprints, typeId) ?? resolveAgentDefinition(blueprints, declaredKind) ?? definitionFromExistingAgent(agent, typeId),
      typeId,
      typeAgent: configured,
      typeAgentData: agent
    };
  }
  const definition = resolveAgentDefinition(blueprints, selector);
  if (!definition) return undefined;
  const typeAgent = findAgentTypeEntity(world, definition.id) ?? findAgentTypeEntity(world, definition.kind);
  const typeAgentData = typeAgent !== undefined ? world.get(typeAgent, Agent) : undefined;
  const typeId = typeAgentData?.id ?? definition.id;
  return { definition, typeId, ...(typeAgent !== undefined ? { typeAgent } : {}), ...(typeAgentData ? { typeAgentData } : {}) };
}

function findAgentTypeBySelector(world: WorldReader, selector: string): Entity | undefined {
  return world.query(Agent).find((entity) => {
    if (isTemporaryAgentEntity(world, entity)) return false;
    const agent = world.get(entity, Agent);
    const kind = world.get(entity, AgentKind)?.kind;
    return agent?.id === selector || kind === selector;
  });
}

function definitionFromExistingAgent(agent: { id: string; name: string; description?: string }, kind: string): BuiltinAgentDefinition {
  return {
    id: agent.id,
    kind,
    name: agent.name,
    description: agent.description,
    systemPrompt: '',
    toolPolicy: { allowedTools: [] }
  };
}

function availableAgentTypes(world: WorldReader, blueprints: BuiltinAgentRegistry): string[] {
  const configured = world.query(Agent)
    .filter((entity) => !isTemporaryAgentEntity(world, entity))
    .map((entity) => world.get(entity, Agent)?.id)
    .filter((id): id is string => !!id);
  return [...new Set([...configured, ...Object.values(blueprints.agents).map((definition) => definition.kind)])];
}

function createRunAgentAgentId(world: WorldReader, kind: string): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `agent-${agentSelectorSlug(kind)}-${createMessageId()}`;
    if (findAgentById(world, id) === undefined) return id;
  }
  return `agent-${agentSelectorSlug(kind)}-${Date.now().toString(36)}`;
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

  const timeout = normalizeRunAgentTimeout(args.timeout);
  if (!timeout.ok) {
    rejectToolCall(cmd, entity, call, state, timeout.reason);
    return;
  }

  const parentTarget = runTarget(world, authorization.run);
  if (!parentTarget) {
    rejectToolCall(cmd, entity, call, state, '无法解析父 AgentRun 目标。');
    return;
  }

  const requestedAgentId = args.agent?.id?.trim();
  const requestedKind = args.agent?.type?.trim() || 'general-purpose';
  const blueprints = world.getResource(AgentBlueprintsKey);
  const resolvedTarget = resolveRunAgentTarget(world, cmd, {
    blueprints,
    requestedAgentId,
    requestedKind,
    sourceConversation: parentTarget.conversation,
    toolCallEntity: entity,
    prompt
  });
  if (!resolvedTarget.ok) {
    rejectToolCall(cmd, entity, call, state, resolvedTarget.reason);
    return;
  }

  const { targetAgent, targetAgentId, definition, resolved } = resolvedTarget.value;
  const policyDefaults = resolveRunAgentPolicyDefaults(definition, undefined);
  if (!resolved.ok) {
    rejectToolCall(cmd, entity, call, state, resolved.reason);
    return;
  }

  if (resolved.value.created) {
    const sourceConversation = world.get(parentTarget.conversation, Conversation);
    const sourceAgent = world.get(parentTarget.agent, Agent);
    spawnConversationOriginLink(cmd, {
      conversation: resolved.value.conversation,
      originKind: 'agent',
      sourceKind: 'toolCall',
      sourceAgent: parentTarget.agent,
      ...(sourceAgent?.id ? { sourceAgentId: sourceAgent.id } : {}),
      sourceConversation: parentTarget.conversation,
      ...(sourceConversation?.id ? { sourceConversationId: sourceConversation.id } : {}),
      sourceToolCall: entity,
      sourceToolCallId: call.id,
      sourceRun: authorization.run,
      sourceRunId: authorization.runId
    });
  }

  const answerBridgeId = `agent-answer:${createMessageId()}`;
  const promptWithAnswerBridge = `${prompt}\n\n[Agent answer bridge]\n本次任务已分配默认 answerBridgeId：${answerBridgeId}。当你需要把阶段性结论或最终正文提交给来源 Agent 时，请调用 submit_agent_answer({ title, content })，未传 answerBridgeId 时会自动使用这个 answerBridgeId；如果用户要求提交到其它 answerBridgeId，可显式传 submit_agent_answer({ answerBridgeId, title, content })。最终自然语言回复可以保持简短。`;
  const inputMessage = spawnUserMessage(cmd, resolved.value.conversation, promptWithAnswerBridge);
  const background = timeout.value === 0;
  const baseDeliveryPolicy: RunDeliveryPolicyBlueprint = {
    ...policyDefaults.deliveryPolicy,
    mode: background ? 'notification' : 'tool_response',
    includeTranscript: 'summary'
  };
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
    answerBridgeId,
    inputMessage,
    deliveryMode,
    includeTranscript
  });
  const inheritedWorkEnvironment = activeWorkEnvironmentForRun(world, authorization.run);
  if (inheritedWorkEnvironment) {
    selectConversationWorkEnvironment(world, cmd, resolved.value.conversation, inheritedWorkEnvironment.entity);
    selectRunWorkEnvironment(world, cmd, childRun, inheritedWorkEnvironment.entity);
  }
  applyRunConversationPolicy(cmd, childRun, resolved.value);
  applyRunContextPolicy(cmd, childRun, policyDefaults.contextPolicy);
  applyRunDeliveryPolicy(cmd, childRun, baseDeliveryPolicy);
  applyRunEditPolicy(cmd, childRun, policyDefaults.editPolicy);

  const childRunId = `run${childRun}`;
  const now = Date.now();
  const progress: RunAgentToolProgress = {
    childRunId,
    runId: childRunId,
    agentId: targetAgentId,
    conversationId: resolved.value.conversationId,
    answerBridgeId,
    timeoutMs: timeout.value,
    startedAt: now
  };
  if (background) {
    completeRunAgentToolAsBackground(cmd, entity, call, state, progress, 'timeout_zero');
    return;
  }

  cmd.add(entity, ToolState, transitionToolState(state, 'executing', { progress }, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'started',
    status: 'executing',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    payload: { ...progress, deliveryMode }
  });
  cmd.add(entity, InFlight, { kind: 'tool', startedAt: now });
}

function resolveRunAgentConversation(
  world: WorldReader,
  cmd: CommandSink,
  input: {
    sourceConversation: Entity;
    targetAgent: Entity;
    targetAgentId: string;
    kind: string;
    toolCallEntity: Entity;
    prompt: string;
    appendToExistingAgent: boolean;
  }
): { ok: true; value: ResolvedConversation } | { ok: false; reason: string } {
  if (input.appendToExistingAgent) {
    const existingConversation = defaultConversationForAgent(world, input.targetAgent);
    if (existingConversation !== undefined) {
      ensureAgentConversationLink(world, cmd, input.targetAgent, existingConversation, 'default');
      const conversationId = world.get(existingConversation, Conversation)?.id ?? String(existingConversation);
      selectAgentForConversation(cmd, { agent: input.targetAgent, conversation: existingConversation, conversationId, agentId: input.targetAgentId });
      return {
        ok: true,
        value: {
          conversation: existingConversation,
          conversationId,
          policyMode: 'reuse_conversation',
          visibility: world.get(existingConversation, Conversation)?.visibility ?? 'collapsed'
        }
      };
    }
  }

  const conversationId = `conversation-${slug(input.targetAgentId)}-${input.toolCallEntity}`;
  const conversation = spawnConversation(cmd, {
    id: conversationId,
    title: `${input.kind}: ${input.prompt.slice(0, 40)}`,
    visibility: 'collapsed'
  });
  initializeCreatedRunAgentConversation(world, cmd, input, conversation, conversationId);
  return {
    ok: true,
    value: {
      conversation,
      conversationId,
      policyMode: 'new_conversation',
      created: true,
      visibility: 'collapsed'
    }
  };
}

function defaultConversationForAgent(world: WorldReader, agent: Entity): Entity | undefined {
  return world.query(AgentConversationLink)
    .map((entity) => world.get(entity, AgentConversationLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.agent === agent)
    .sort((left, right) => rolePriority(right.role) - rolePriority(left.role) || right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))[0]?.conversation;
}

function rolePriority(role: string): number {
  return role === 'default' ? 2 : role === 'participant' ? 1 : 0;
}

function initializeCreatedRunAgentConversation(
  world: WorldReader,
  cmd: CommandSink,
  input: { sourceConversation: Entity; targetAgent: Entity; targetAgentId: string },
  conversation: Entity,
  conversationId: string
): void {
  linkAgentToConversation(cmd, { agent: input.targetAgent, conversation, role: 'default' });
  selectAgentForConversation(cmd, { agent: input.targetAgent, conversation, conversationId, agentId: input.targetAgentId });
  selectGlobalModeForConversation(cmd, conversation, conversationId);
  inheritPrimaryProjectFromSourceConversation(world, cmd, input.sourceConversation, conversation);
}

function inheritPrimaryProjectFromSourceConversation(world: WorldReader, cmd: CommandSink, sourceConversation: Entity, targetConversation: Entity): Entity | undefined {
  const sourceLink = world
    .query(ConversationProjectLink)
    .map((entity) => world.get(entity, ConversationProjectLink))
    .find((link) => link?.conversation === sourceConversation && link.role === 'primary');
  if (!sourceLink) return undefined;
  const now = Date.now();
  const entity = cmd.spawn();
  cmd.add(entity, ConversationProjectLink, {
    id: `cpl-${entity}`,
    conversation: targetConversation,
    projectContext: sourceLink.projectContext,
    role: 'primary',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

function ensureAgentConversationLink(world: WorldReader, cmd: CommandSink, agent: Entity, conversation: Entity, role: 'default' | 'participant' | 'reviewer'): void {
  const exists = world.query(AgentConversationLink).some((entity) => {
    const link = world.get(entity, AgentConversationLink);
    return !!link && link.agent === agent && link.conversation === conversation;
  });
  if (!exists) linkAgentToConversation(cmd, { agent, conversation, role });
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

function applyRunContextPolicy(cmd: CommandSink, run: Entity, contextPolicy: RunContextPolicyBlueprint): void {
  const policy = cmd.spawn();
  cmd.add(policy, RunContextPolicy, {
    id: `run-context-policy:${run}`,
    ...contextPolicy
  });
  const link = cmd.spawn();
  const now = Date.now();
  cmd.add(link, RunContextPolicyLink, { id: `run-context-policy-link:${run}`, run, policy, role: 'active', createdAt: now, updatedAt: now });
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

function autoApplyYoloAwaitingChanges(world: WorldReader, cmd: CommandSink, handled: Set<Entity>): void {
  const awaitingChanges = world
    .query(ToolCall, ToolState)
    .filter((entity) => {
      const state = world.get(entity, ToolState);
      return !handled.has(entity)
        && !world.has(entity, InFlight)
        && state?.status === 'awaiting_change_apply';
    })
    .sort((left, right) => compareToolCallOrder(world, left, right));

  for (const entity of awaitingChanges) {
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);
    if (!call || !state) continue;
    const authorization = authorizeRunToolExecution(world, entity, call);
    if (!authorization.ok) {
      rejectToolCall(cmd, entity, call, state, authorization.reason);
      handled.add(entity);
      continue;
    }
    if (!isYoloToolPolicy(authorization.policy)) continue;
    const proposal = pendingFileChangeProposal(state.result);
    if (!proposal) continue;
    applyPendingToolChange(world, cmd, entity, call, state, authorization, proposal);
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
  return world.query(Agent).find((agent) => world.get(agent, AgentKind)?.kind === kind || world.get(agent, Agent)?.id === kind);
}

function findAgentRunById(world: WorldReader, id: string): Entity | undefined {
  return world.query(AgentRun).find((run) => world.get(run, AgentRun)?.id === id);
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

function toolGateSettings(world: WorldReader, policy: ToolPolicyData, toolName: string): { autoApproveExecution: boolean; autoApplyChange: boolean; autoSubmitResult: boolean } {
  if (isYoloToolPolicy(policy)) return { autoApproveExecution: true, autoApplyChange: true, autoSubmitResult: true };
  const config = policy.toolConfigs?.[toolName];
  const definitions = world.tryGetResource(ToolRuntimeDefinitionsKey) ?? [];
  const meta = definitions.find((tool) => tool.declaration.name === toolName)?.declaration.metadata;
  return {
    autoApproveExecution: config?.autoApproveExecution ?? meta?.defaultAutoApproveExecution ?? true,
    autoApplyChange: config?.autoApplyChange ?? meta?.defaultAutoApplyChange ?? true,
    autoSubmitResult: config?.autoSubmitResult ?? meta?.defaultAutoSubmitResult ?? true
  };
}

function requiresExecutionApproval(world: WorldReader, toolPolicy: ToolPolicyData, call: ToolCallData): boolean {
  if (toolGateSettings(world, toolPolicy, call.name).autoApproveExecution !== false) return false;
  // 未开启"自动批准执行"时，若该工具开启了"只读命令自动跳过审批"且本次调用被标记为只读，则仍免审批。
  if (autoApprovesReadonlyCommand(world, toolPolicy, call)) return false;
  return true;
}

/** 命令工具专属：config 的 autoApproveReadonly 开启(默认开)且本次调用 readonly=true 时放行。 */
function autoApprovesReadonlyCommand(world: WorldReader, toolPolicy: ToolPolicyData, call: ToolCallData): boolean {
  const config = effectiveToolConfig(world, toolPolicy, call.name);
  if (config?.autoApproveReadonly === undefined || config.autoApproveReadonly === false) return false;
  return isReadonlyCommandCall(parseToolCallArgs(call.argsJson));
}

function parseToolCallArgs(argsJson: string | undefined): unknown {
  if (!argsJson) return {};
  try { return JSON.parse(argsJson); }
  catch { return {}; }
}

function startInlineToolExecution(
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  state: ToolStateData,
  payload?: unknown
): { state: ToolStateData; startedAt: number } {
  const startedAt = Date.now();
  const executing = transitionToolState(state, 'executing', {}, startedAt);
  cmd.add(entity, ToolState, executing);
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'started',
    status: 'executing',
    at: startedAt,
    elapsedMs: Math.max(0, startedAt - call.createdAt),
    ...(payload !== undefined ? { payload } : {})
  });
  return { state: executing, startedAt };
}

function applyPendingToolChange(
  world: WorldReader,
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  state: ToolStateData,
  authorization: Extract<AuthorizationResult, { ok: true }>,
  proposal: FsPendingFileChangeProposal
): void {
  const now = Date.now();
  const config = effectiveToolConfig(world, authorization.policy, call.name);
  const workEnvironment = activeWorkEnvironmentForRun(world, authorization.run)?.data;
  const accessibleWorkEnvironments = pathAccessibleWorkEnvironmentsForRun(world, authorization.run).map((item) => toPublicWorkEnvironmentRecord(item.data));
  cmd.effect({
    kind: 'tool.change.apply',
    toolCallId: call.id,
    name: call.name,
    proposal,
    ...(workEnvironment ? { workEnvironment: toPublicWorkEnvironmentRecord(workEnvironment) } : {}),
    ...(accessibleWorkEnvironments.length > 0 ? { accessibleWorkEnvironments } : {}),
    allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(config, false)
  });
  cmd.add(entity, ToolState, transitionToolState(state, 'applying_change', {}, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'state',
    status: 'applying_change',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    payload: { executorAgentId: authorization.agentId, runId: authorization.runId }
  });
  cmd.add(entity, InFlight, { kind: 'tool', startedAt: now });
}

function pendingFileChangeProposal(result: unknown): FsPendingFileChangeProposal | undefined {
  const output = asPlainRecord(asPlainRecord(result)?.output);
  const proposal = asPlainRecord(output?.proposal);
  if (proposal?.kind !== 'file_change.proposal') return undefined;
  if (proposal.operation !== 'write' && proposal.operation !== 'edit') return undefined;
  if (typeof proposal.path !== 'string' || typeof proposal.baseContent !== 'string' || typeof proposal.targetContent !== 'string') return undefined;
  if (typeof proposal.baseExisted !== 'boolean' || !Array.isArray(proposal.applyHunks)) return undefined;
  return proposal as unknown as FsPendingFileChangeProposal;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
