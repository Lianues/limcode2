import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent, AgentConversationLink, AgentKind, type AgentData } from '../../agent/components';
import { agentSelectorSlug, isTemporaryAgentEntity } from '../../agent/identity';
import {
  AgentBlueprintsKey,
  type BuiltinAgentDefinition,
  type BuiltinAgentRegistry,
  type BuiltinWorkflowDefinition
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
  ConversationWorkflowSelection,
  Workflow,
  ToolPolicy,
  type ToolPolicyData
} from '../../workflow/components';
import { WorkflowBundle, selectDefaultWorkflowForConversation } from '../../workflow/bundles';
import {
  AgentRun,
  AgentRunSourceLink,
  type AgentRunSourceLinkData,
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
  RunWorkflowLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from '../../agentRun/components';
import { AgentRunEventType } from '../../agentRun/events';
import { AgentRunBundle, spawnAgentRun } from '../../agentRun/bundles';
import { spawnAgentRunNotification } from '../../agentRun/notificationDelivery';
import {
  activeToolPolicyForRun,
  answerBridgeIdForConversation,
  conversationForAnswerBridgeId,
  conversationHasActiveRun,
  defaultAgentForConversation,
  latestAnswerBridgeSourceById,
  runForToolCall,
  runSource,
  runTarget,
  toolCallEntityById
} from '../../agentRun/queries';
import { AgentAnswerBundle, spawnAgentAnswer } from '../../agentAnswer/bundles';
import { AgentAnswer, AgentAnswerSubmissionLink, AgentAnswerTargetLink } from '../../agentAnswer/components';
import { agentAnswerById } from '../../agentAnswer/queries';
import { createCompletedAgentAnswerModelResponse } from '../../agentAnswer/modelResponse';
import { LlmInvocation, RunLlmInvocationLink } from '../../llm/components';
import { ToolCallEventBundle, spawnToolCallEvent } from '../bundles';
import { ToolCall, ToolPolicyScopeLink, ToolResultConsumed, ToolState, type ToolCallData, type ToolStateData } from '../components';
import { ToolEventType } from '../events';
import { isTerminalToolStatus, transitionToolState } from '../state';
import { interruptToolCall } from '../interrupt';
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
import { isToolNameAllowedByPolicy, isYoloToolPolicy } from '../policy';
import { spawnCheckpointBarrier, consumeReleasedCheckpointBarrier, newestBarrierForTarget } from '../../checkpoint/barriers';
import { effectiveCheckpointPolicyForRequest } from '../../checkpoint/queries';
import { effectiveCheckpointToolTriggerConfig } from '../../checkpoint/policy';
import { isReadonlyCommandCall } from '../definitions/command';
import { normalizeAskUserToolRequest } from '../../../../../shared/askUser';
import { renderPlanMarkdown } from '../../../../../shared/planMarkdown';
import { DELEGATED_PLAN_APPROVAL_MESSAGE, normalizeSubmitPlanToolRequest } from '../../../../../shared/planReview';
import { allowOutsideProjectPathsFromConfig } from '../definitions/filePathPolicy';
import { DEFAULT_RUN_AGENT_TYPE, RUN_AGENT_TOOL_NAME } from '../definitions/runAgent';
import {
  compareToolCallOrder,
  isExecutionApproved,
  isInActiveExecutionBatch,
  progressRecord
} from '../scheduling';
import {
  createMessageId,
  ASK_USER_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  EDIT_TOOL_NAME,
  WRITE_TOOL_NAME,
  DELETE_TOOL_NAME,
  SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  TRANSFER_TOOL_NAME,
  READ_AGENT_ANSWER_TOOL_NAME,
  SUBMIT_AGENT_ANSWER_TOOL_NAME,
  type AgentRunKind,
  type AgentRunStatus,
  type ContextHistoryMode,
  type ConversationPolicyMode,
  type ConversationVisibility,
  type DeliveryMode,
  type LlmInvocationSettingsSnapshotRecord,
  type MessageContent,
  type NewMessageWhileRunningBehavior,
  type SourceEditBehavior,
  type PlanReviewRequiredToolRiskLevel,
  type ToolConfigRecord,
  type ToolRiskLevel,
  type TranscriptInclusion
} from '../../../../../shared/protocol';
import type { FsPendingFileChangeProposal } from '../../../../capabilities/types';
import { PlanProposal, PlanReviewPolicy, PlanReviewPolicyScopeLink, RunPlanProposalLink } from '../../plan/components';
import { PlanReviewBundle, linkPlanProposalToRun, upsertPlanProposal } from '../../plan/bundles';
import { completePlanDecision, findPlanProposalById, isPendingPlanDecision } from '../../plan/decision';
import { PlanReviewEventType } from '../../plan/events';
import { effectivePlanReviewPolicyForRun, hasApprovedPlanForRun, planReviewRequiresRiskLevel } from '../../plan/queries';

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
    ConversationWorkflowSelection,
    Workflow,
    ToolPolicy,
    ToolPolicyScopeLink,
    PlanReviewPolicy,
    PlanReviewPolicyScopeLink,
    PlanProposal,
    RunPlanProposalLink,
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
    RunToolPolicyLink,
    LlmInvocation,
    RunLlmInvocationLink
  ],
  write: [ToolState, AgentRun, AgentAnswer, RunDeliveryPolicy, PlanProposal],
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
    bundles: [ToolCallEventBundle, ConversationBundle, ConversationLinkBundle, MessageBundle, AgentRunBundle, AgentAnswerBundle, AgentFromBlueprintBundle, WorkflowBundle, ConversationProjectLinkBundle, WorkEnvironmentBundle, PlanReviewBundle],
    events: {
      read: [
        ToolEventType.ExecutionApproveRequested,
        ToolEventType.ExecutionRejectRequested,
        ToolEventType.ExecutionCancelRequested,
        ToolEventType.ChangeApplyRequested,
        ToolEventType.ChangeRejectRequested,
        PlanReviewEventType.ProposalApproveRequested
      ],
      emit: [CheckpointEventType.Requested, AgentRunEventType.Cancel, AgentRunEventType.Promote]
    },
    effects: { emit: ['tool.run', 'tool.change.apply', 'tool.abort'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    backgroundForegroundWaitElapsedRunAgentTools(world, cmd);

    const handled = new Set<Entity>();

    // “新开对话执行”的 Plan 批准由这里复用 run_agent 的子 Agent 启动链路；
    // PlanProposalDecisionSystem 只处理 current_conversation，避免同一批准完成两次。
    for (const request of readEvents(ctx, PlanReviewEventType.ProposalApproveRequested)) {
      if (request.executionTarget !== 'new_conversation') continue;
      const entity = toolCallEntityById(world, request.toolCallId);
      if (entity === undefined || handled.has(entity)) continue;
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state || call.name !== SUBMIT_PLAN_TOOL_NAME || state.status !== 'awaiting_user_input') continue;
      handled.add(entity);
      executeDelegatedSubmitPlanApproval(world, cmd, entity, call, request.planProposalId, request.agentType);
    }

    // 用户对单个工具调用点“中断”：非终态即标记为“被用户中断执行”，并对在途运行时工具尽力 emit tool.abort。
    // run 仍存活，ToolResultSystem 会把该结果正常回传模型，同批其它工具不受影响。
    for (const request of readEvents(ctx, ToolEventType.ExecutionCancelRequested)) {
      const entity = toolCallEntityById(world, request.toolCallId);
      if (entity === undefined || handled.has(entity)) continue;
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state) continue;
      const reason = request.reason?.trim() || undefined;
      if (interruptToolCall(cmd, entity, call, state, { reason, emitAbort: call.name !== ASK_USER_TOOL_NAME && call.name !== SUBMIT_PLAN_TOOL_NAME })) {
        rejectPendingSubmitPlanProposal(world, cmd, call);
        cancelSynchronousRunAgentChild(cmd, call, state, reason);
        handled.add(entity);
      }
    }

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
      const planGate = authorizePlanReviewForTool(world, call, authorization);
      if (!planGate.ok) {
        rejectToolCall(cmd, entity, call, state, planGate.reason);
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
      const planGate = authorizePlanReviewForTool(world, call, authorization);
      if (!planGate.ok) {
        rejectToolCall(cmd, entity, call, state, planGate.reason);
        continue;
      }
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

      const planGate = authorizePlanReviewForTool(world, call, authorization);
      if (!planGate.ok) {
        rejectToolCall(cmd, entity, call, state, planGate.reason);
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
  return state.status === 'awaiting_user_input' || state.status === 'executing' || state.status === 'success' || state.status === 'warning' || state.status === 'error';
}

function rejectPendingSubmitPlanProposal(world: WorldReader, cmd: CommandSink, call: ToolCallData): void {
  if (call.name !== SUBMIT_PLAN_TOOL_NAME) return;
  const proposalId = `plan-proposal:${call.id}`;
  const proposalEntity = world.query(PlanProposal).find((entity) => world.get(entity, PlanProposal)?.id === proposalId);
  if (proposalEntity === undefined) return;
  const proposal = world.get(proposalEntity, PlanProposal);
  if (!proposal || proposal.status !== 'pending') return;
  cmd.add(proposalEntity, PlanProposal, {
    ...proposal,
    status: 'rejected',
    updatedAt: Date.now()
  });
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
  if (!isToolNameAllowedByPolicy(policy, call.name, definition)) {
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

type PlanReviewGateResult = { ok: true } | { ok: false; reason: string };

function authorizePlanReviewForTool(world: WorldReader, call: ToolCallData, authorization: Extract<AuthorizationResult, { ok: true }>): PlanReviewGateResult {
  if (call.name === SUBMIT_PLAN_TOOL_NAME) return { ok: true };
  const resolution = effectivePlanReviewPolicyForRun(world, authorization.run);
  const policy = resolution.policy;
  if (policy.mode !== 'before_mutation') return { ok: true };

  const riskLevel = planReviewRiskLevelForTool(world, call);
  if (riskLevel === 'read') {
    if (policy.allowReadonlyBeforeApproval || hasApprovedPlanForRun(world, authorization.run)) return { ok: true };
    return { ok: false, reason: '当前工作流要求 Plan 批准后才能继续执行工具。请先调用 submit_plan 并等待用户批准。' };
  }

  const requiredRiskLevel = toPlanReviewRequiredRiskLevel(riskLevel);
  if (!requiredRiskLevel || !planReviewRequiresRiskLevel(policy, requiredRiskLevel)) return { ok: true };
  if (hasApprovedPlanForRun(world, authorization.run)) return { ok: true };
  return { ok: false, reason: '当前工作流要求先提交并批准 Plan。请先调用 submit_plan，等待用户批准后再执行会修改文件、运行非只读命令或启动子 Agent 的工具。' };
}

function planReviewRiskLevelForTool(world: WorldReader, call: ToolCallData): ToolRiskLevel {
  if (call.name === EDIT_TOOL_NAME || call.name === WRITE_TOOL_NAME || call.name === DELETE_TOOL_NAME) return 'write';
  if (isCommandToolName(call.name)) return isReadonlyCommandCall(parseToolCallArgs(call.argsJson)) ? 'read' : 'command';
  if (isAgentRunTool(world, call.name)) return 'agent';
  const definition = (world.tryGetResource(ToolDefinitionsKey) ?? []).find((tool) => tool.name === call.name);
  if (definition?.metadata?.readonly === true) return 'read';
  return definition?.metadata?.riskLevel ?? 'read';
}

function toPlanReviewRequiredRiskLevel(riskLevel: ToolRiskLevel): PlanReviewRequiredToolRiskLevel | undefined {
  return riskLevel === 'write' || riskLevel === 'command' || riskLevel === 'agent' ? riskLevel : undefined;
}

function isCommandToolName(toolName: string): boolean {
  return toolName === 'shell' || toolName === 'bash';
}

function dispatchToolCall(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  if (!isRunAgentInterruptCall(call) && awaitToolExecutionBeforeCheckpoint(world, cmd, entity, call, authorization)) return;
  if (call.name === ASK_USER_TOOL_NAME) {
    executeAskUserTool(cmd, entity, call, state);
    return;
  }
  if (call.name === SUBMIT_PLAN_TOOL_NAME) {
    executeSubmitPlanTool(world, cmd, entity, call, state, authorization);
    return;
  }
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

function executeAskUserTool(cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData): void {
  try {
    normalizeAskUserToolRequest(call.argsJson);
  } catch (error) {
    rejectToolCall(cmd, entity, call, state, error instanceof Error ? error.message : String(error));
    return;
  }

  const now = Date.now();
  cmd.add(entity, ToolState, transitionToolState(state, 'awaiting_user_input', {}, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'state',
    status: 'awaiting_user_input',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    payload: { waitingFor: 'user_answer' }
  });
}

function executeSubmitPlanTool(
  world: WorldReader,
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  state: ToolStateData,
  authorization: Extract<AuthorizationResult, { ok: true }>
): void {
  let request;
  try {
    request = normalizeSubmitPlanToolRequest(call.argsJson);
  } catch (error) {
    rejectToolCall(cmd, entity, call, state, error instanceof Error ? error.message : String(error));
    return;
  }

  const proposalId = `plan-proposal:${call.id}`;
  const proposal = upsertPlanProposal(world, cmd, {
    id: proposalId,
    body: request.plan,
    ...(request.taskList ? { taskList: request.taskList } : {}),
    status: 'pending'
  });
  linkPlanProposalToRun(world, cmd, {
    run: authorization.run,
    runId: authorization.runId,
    planProposal: proposal,
    planProposalId: proposalId
  });

  const now = Date.now();
  cmd.add(entity, ToolState, transitionToolState(state, 'awaiting_user_input', {
    progress: { planProposalId: proposalId, waitingFor: 'plan_review' }
  }, now));
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'state',
    status: 'awaiting_user_input',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    payload: { waitingFor: 'plan_review', planProposalId: proposalId, runId: authorization.runId }
  });
}

function executeDelegatedSubmitPlanApproval(
  world: WorldReader,
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  planProposalId: string,
  requestedAgentType: string
): void {
  const proposalEntity = findPlanProposalById(world, planProposalId);
  if (proposalEntity === undefined || !isPendingPlanDecision(world, entity, proposalEntity)) return;

  const fail = (reason: string): void => {
    completePlanDecision(world, cmd, entity, planProposalId, 'rejected', `Plan 分派失败：${reason}`);
  };

  let request: ReturnType<typeof normalizeSubmitPlanToolRequest>;
  try {
    request = normalizeSubmitPlanToolRequest(call.argsJson);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const sourceRun = runForToolCall(world, entity);
  const sourceRunData = sourceRun === undefined ? undefined : world.get(sourceRun, AgentRun);
  if (sourceRun === undefined || !sourceRunData) {
    fail('submit_plan 没有关联可用的父 AgentRun。');
    return;
  }

  const agentType = requestedAgentType.trim();
  if (!agentType) {
    fail('没有选择执行 Agent 类型。');
    return;
  }

  const launched = launchChildAgentRun(world, cmd, {
    sourceRun,
    sourceRunId: sourceRunData.id,
    sourceToolCall: entity,
    sourceToolCallId: call.id,
    prompt: delegatedPlanPrompt(request),
    requestedKind: agentType,
    foregroundWaitMs: 0,
    runKind: 'delegated'
  });
  if (!launched.ok) {
    fail(launched.reason);
    return;
  }

  const progress = launched.value.progress;
  completePlanDecision(
    world,
    cmd,
    entity,
    planProposalId,
    'approved',
    DELEGATED_PLAN_APPROVAL_MESSAGE,
    {
      executionTarget: 'new_conversation',
      delegationStatus: 'backgrounded',
      agentId: progress.agentId,
      agentType: progress.agentType,
      runId: progress.runId,
      conversationId: progress.conversationId,
      answerBridgeId: progress.answerBridgeId
    }
  );
}

function delegatedPlanPrompt(request: ReturnType<typeof normalizeSubmitPlanToolRequest>): string {
  const planMarkdown = renderPlanMarkdown({
    plan: request.plan,
    ...(request.taskList ? { taskList: request.taskList } : {}),
    statusLabel: 'Plan 已批准'
  });
  return [
    '[Approved Plan Delegation]',
    '用户已批准以下实施 Plan，并选择由你在新的 Agent 对话中负责执行。请独立完成实际落地，不要只复述或重新规划。',
    '',
    planMarkdown,
    '',
    '## 执行要求',
    '1. 严格按照已批准 Plan 和任务清单推进；仅在确有必要时做最小调整。',
    '2. 如果提供了任务清单，先使用 update_task_list 将其同步到当前子对话，并在执行过程中持续更新状态。',
    '3. 完成实现后运行适当验证，清楚记录结果、剩余风险和任何未完成事项。',
    '4. 完成或需要向来源 Agent 返回阶段性结论时，必须调用 submit_agent_answer({ title, content })；不要只依赖普通自然语言回复。'
  ].join('\n');
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

  const resolvedBridge = resolveSubmitAgentAnswerBridge(world, authorization.run, args.answerBridgeId?.trim());
  if (!resolvedBridge) {
    rejectToolCall(cmd, entity, call, state, 'submit_agent_answer 缺少 answerBridgeId，且当前 AgentRun 没有默认 answerBridgeId。');
    return;
  }

  const { answerBridgeId, source } = resolvedBridge;
  const submitterTarget = runTarget(world, authorization.run);
  const parentTarget = source?.sourceRun !== undefined ? runTarget(world, source.sourceRun) : undefined;
  const targetAgent = source?.sourceAgent ?? parentTarget?.agent;
  const targetConversation = source?.sourceConversation ?? parentTarget?.conversation;

  const existingAnswer = agentAnswerById(world, answerBridgeId);
  const existingAnswerData = existingAnswer !== undefined ? world.get(existingAnswer, AgentAnswer) : undefined;
  if (existingAnswer !== undefined && existingAnswerData) {
    const now = Date.now();
    cmd.add(existingAnswer, AgentAnswer, { ...existingAnswerData, title, content, updatedAt: now });
    notifyAgentAnswerSubmitted(world, cmd, {
      answerBridgeId,
      title,
      content,
      source,
      submitterRun: authorization.run,
      submitterRunId: authorization.runId,
      submitterTarget
    });
    completeInlineToolCallSuccess(cmd, entity, call, state, { ok: true, answerBridgeId, updated: true });
    return;
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

  notifyAgentAnswerSubmitted(world, cmd, {
    answerBridgeId: spawned.id,
    title,
    content,
    source,
    submitterRun: authorization.run,
    submitterRunId: authorization.runId,
    submitterTarget
  });
  completeInlineToolCallSuccess(cmd, entity, call, state, { ok: true, answerBridgeId: spawned.id });
}

interface ResolvedSubmitAnswerBridge {
  answerBridgeId: string;
  source?: AgentRunSourceLinkData;
}

function resolveSubmitAgentAnswerBridge(world: WorldReader, run: Entity, explicitAnswerBridgeId: string | undefined): ResolvedSubmitAnswerBridge | undefined {
  const explicit = explicitAnswerBridgeId?.trim();
  if (explicit) {
    const source = answerBridgeSourceForNotification(world, explicit);
    return { answerBridgeId: explicit, ...(source ? { source } : {}) };
  }

  const currentSource = runSource(world, run);
  const currentSourceId = currentSource?.answerBridgeId?.trim();
  const fallbackId = currentSourceId || answerBridgeIdForRunConversation(world, run);
  if (!fallbackId) return undefined;
  const source = answerBridgeSourceForNotification(world, fallbackId) ?? currentSource;
  return { answerBridgeId: fallbackId, ...(source ? { source } : {}) };
}

function answerBridgeIdForRunConversation(world: WorldReader, run: Entity): string | undefined {
  const target = runTarget(world, run);
  return target ? answerBridgeIdForConversation(world, target.conversation) : undefined;
}

function answerBridgeSourceForNotification(world: WorldReader, answerBridgeId: string): AgentRunSourceLinkData | undefined {
  const normalized = answerBridgeId.trim();
  if (!normalized) return undefined;
  return world
    .query(AgentRunSourceLink)
    .map((entity) => world.get(entity, AgentRunSourceLink))
    .filter((candidate): candidate is AgentRunSourceLinkData => !!candidate && candidate.answerBridgeId?.trim() === normalized)
    .sort((left, right) => compareAnswerBridgeNotificationSource(world, left, right))[0]
    ?? latestAnswerBridgeSourceById(world, normalized);
}

function compareAnswerBridgeNotificationSource(world: WorldReader, left: AgentRunSourceLinkData, right: AgentRunSourceLinkData): number {
  return answerBridgeNotificationSourcePriority(world, right) - answerBridgeNotificationSourcePriority(world, left)
    || (right.updatedAt || right.createdAt) - (left.updatedAt || left.createdAt)
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id);
}

function answerBridgeNotificationSourcePriority(world: WorldReader, source: AgentRunSourceLinkData): number {
  if (source.sourceToolCall !== undefined) return 50;
  if (source.sourceRun !== undefined && source.sourceConversation !== undefined && source.sourceAgent !== undefined) return 40;
  if (source.sourceRun !== undefined && source.sourceConversation !== undefined) return 35;
  if (source.sourceAgent !== undefined && source.sourceConversation !== undefined) return 30;
  const target = runTarget(world, source.run);
  return target?.conversation !== source.sourceConversation ? 20 : 10;
}

function notifyAgentAnswerSubmitted(
  world: WorldReader,
  cmd: CommandSink,
  input: {
    answerBridgeId: string;
    title: string;
    content: string;
    source?: AgentRunSourceLinkData;
    submitterRun: Entity;
    submitterRunId: string;
    submitterTarget?: { agent: Entity; conversation: Entity };
  }
): void {
  const sourceConversation = answerNotificationTargetConversation(world, input.source);
  if (sourceConversation === undefined) return;
  if (input.submitterTarget?.conversation === sourceConversation && input.source?.sourceToolCall === undefined && input.source?.sourceRun === undefined) {
    return;
  }

  if (input.source?.sourceToolCall !== undefined && completeSourceRunAgentToolWithSubmittedAnswer(world, cmd, input.source.sourceToolCall, input)) {
    return;
  }

  const parentTarget = input.source?.sourceRun !== undefined ? runTarget(world, input.source.sourceRun) : undefined;
  const agent = input.source?.sourceAgent ?? parentTarget?.agent ?? defaultAgentForConversation(world, sourceConversation);
  spawnAgentRunNotification(world, cmd, {
    conversation: sourceConversation,
    ...(agent !== undefined ? { agent } : {}),
    text: serializedSubmittedAgentAnswerNotification(world, input),
    sourceKind: 'agentRun',
    sourceRun: input.submitterRun,
    sourceConversation,
    promoteIfActive: true
  });
}

function completeSourceRunAgentToolWithSubmittedAnswer(
  world: WorldReader,
  cmd: CommandSink,
  toolCallEntity: Entity,
  input: { answerBridgeId: string; title: string; content: string; submitterRun: Entity; submitterRunId: string; submitterTarget?: { agent: Entity; conversation: Entity } }
): boolean {
  const call = world.get(toolCallEntity, ToolCall);
  const state = world.get(toolCallEntity, ToolState);
  if (!call || !state || isTerminalToolStatus(state.status)) return false;

  const now = Date.now();
  const durationMs = Math.max(0, now - call.createdAt);
  const result = submittedAgentAnswerResult(world, input);
  cmd.add(toolCallEntity, ToolState, transitionToolState(state, 'success', { result, durationMs }, now));
  cmd.remove(toolCallEntity, InFlight);
  spawnToolCallEvent(cmd, {
    toolCall: toolCallEntity,
    toolCallId: call.id,
    kind: 'completed',
    status: 'success',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    durationMs,
    payload: result
  });
  return true;
}

function answerNotificationTargetConversation(world: WorldReader, source: AgentRunSourceLinkData | undefined): Entity | undefined {
  if (!source) return undefined;
  if (source.sourceConversation !== undefined) return source.sourceConversation;
  return source.sourceRun !== undefined ? runTarget(world, source.sourceRun)?.conversation : undefined;
}

function serializedSubmittedAgentAnswerNotification(
  world: WorldReader,
  input: { answerBridgeId: string; title: string; content: string; submitterRun: Entity; submitterRunId: string; submitterTarget?: { agent: Entity; conversation: Entity } }
): string {
  return [
    '[Agent answer submitted]',
    '子 Agent 已通过 submit_agent_answer 提交/更新回答。下面是等同于 read_agent_answer 工具成功响应的序列化文本，请把它当作该后台 Agent 主动返回给当前对话的结果：',
    JSON.stringify(submittedAgentAnswerResult(world, input), null, 2)
  ].join('\n\n');
}

function submittedAgentAnswerResult(
  world: WorldReader,
  input: { answerBridgeId: string; title: string; content: string; submitterTarget?: { agent: Entity; conversation: Entity } }
): ReturnType<typeof createCompletedAgentAnswerModelResponse> {
  const agentType = input.submitterTarget?.agent !== undefined ? world.get(input.submitterTarget.agent, AgentKind)?.kind : undefined;
  return createCompletedAgentAnswerModelResponse({
    answerBridgeId: input.answerBridgeId,
    ...(agentType ? { agentType } : {}),
    title: input.title,
    content: input.content
  });
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
    // 尚无 answer 时，用 answerBridgeId 串起来的子对话状态来区分三种情况，避免上游 Agent 误判为失败：
    //   running     —— 子对话仍有活跃 run（首轮或手动重试都算）；等待或稍后重试即可。
    //   interrupted —— 子对话存在但没有活跃 run，也没提交 answer（子 Agent 报错/中断）；可用同 answerBridgeId 继续/追加。
    //   not_found   —— 该 answerBridgeId 完全没有对应子对话。
    const child = conversationForAnswerBridgeId(world, answerBridgeId);
    if (child?.hasActiveRun) {
      const agentType = child.agent !== undefined ? world.get(child.agent, AgentKind)?.kind : undefined;
      completeInlineToolCallSuccess(cmd, entity, call, state, {
        ok: false,
        answerBridgeId,
        status: 'running',
        ...(agentType ? { agentType } : {}),
        error: '对应 answerBridgeId 绑定的子 Agent 正在运行，尚未通过 submit_agent_answer 提交内容。请稍后重试 read_agent_answer，或等待其主动提交后的通知。'
      });
      return;
    }
    if (child) {
      const agentType = child.agent !== undefined ? world.get(child.agent, AgentKind)?.kind : undefined;
      completeInlineToolCallSuccess(cmd, entity, call, state, {
        ok: false,
        answerBridgeId,
        status: 'interrupted',
        ...(agentType ? { agentType } : {}),
        error: `对应 answerBridgeId 绑定的子 Agent 已中断（没有在运行、也没有提交 answer）。请调用 run_agent({ answerBridgeId: "${answerBridgeId}", prompt, foregroundWaitMs }) 继续/追加同一个子对话；默认 submit_agent_answer 通道会继续沿用该 answerBridgeId。`
      });
      return;
    }
    completeInlineToolCallSuccess(cmd, entity, call, state, {
      ok: false,
      answerBridgeId,
      status: 'not_found',
      error: `未找到 answerBridgeId：${answerBridgeId}（既没有已提交的 answer，也没有对应的子对话）。请确认该 answerBridgeId 是否正确。`
    });
    return;
  }

  const submission = world.query(AgentAnswerSubmissionLink)
    .map((linkEntity) => world.get(linkEntity, AgentAnswerSubmissionLink))
    .find((link) => link?.answer === answerEntity);
  const agentType = submission?.submitterAgent !== undefined
    ? world.get(submission.submitterAgent, AgentKind)?.kind
    : undefined;
  completeInlineToolCallSuccess(cmd, entity, call, state, createCompletedAgentAnswerModelResponse({
    answerBridgeId: answer.id,
    ...(agentType ? { agentType } : {}),
    title: answer.title,
    content: answer.content
  }));
}

function backgroundForegroundWaitElapsedRunAgentTools(world: WorldReader, cmd: CommandSink): void {
  const now = Date.now();
  for (const entity of world.query(ToolCall, ToolState)) {
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);
    if (!call || !state || call.name !== RUN_AGENT_TOOL_NAME || state.status !== 'executing') continue;
    const progress = runAgentToolProgress(state.progress);
    const foregroundWaitMs = progress.foregroundWaitMs;
    const startedAt = progress.startedAt ?? call.createdAt;
    if (foregroundWaitMs === undefined || foregroundWaitMs <= 0) continue;
    if (now - startedAt < foregroundWaitMs) continue;

    const run = progress.runId ? findAgentRunById(world, progress.runId) : undefined;
    if (run !== undefined) setRunDeliveryPolicyMode(world, cmd, run, 'notification');

    completeRunAgentToolAsBackground(cmd, entity, call, state, progress, 'foreground_wait_elapsed');
  }
}

function cancelSynchronousRunAgentChild(cmd: CommandSink, call: ToolCallData, state: ToolStateData, reason: string | undefined): void {
  if (call.name !== RUN_AGENT_TOOL_NAME) return;
  const progress = runAgentToolProgress(state.progress);
  if (!progress.runId) return;
  enqueueRunAgentTreeCancellation(cmd, progress.runId, reason ?? 'run_agent tool call cancelled before it returned.');
}

function enqueueRunAgentTreeCancellation(cmd: CommandSink, runId: string, reason: string): void {
  cmd.enqueue({
    type: AgentRunEventType.Cancel,
    payload: { runId, reason, cascadeChildAgents: true }
  });
}


function runAgentToolProgress(value: unknown): RunAgentToolProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    childRunId: typeof record.childRunId === 'string' ? record.childRunId : undefined,
    runId: typeof record.runId === 'string' ? record.runId : undefined,
    agentId: typeof record.agentId === 'string' ? record.agentId : undefined,
    agentType: typeof record.agentType === 'string' ? record.agentType : undefined,
    conversationId: typeof record.conversationId === 'string' ? record.conversationId : undefined,
    answerBridgeId: typeof record.answerBridgeId === 'string' ? record.answerBridgeId : undefined,
    foregroundWaitMs: typeof record.foregroundWaitMs === 'number' && Number.isFinite(record.foregroundWaitMs) ? record.foregroundWaitMs : undefined,
    startedAt: typeof record.startedAt === 'number' && Number.isFinite(record.startedAt) ? record.startedAt : undefined
  };
}

function completeRunAgentToolAsBackground(
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  state: ToolStateData,
  progress: RunAgentToolProgress,
  reason: 'foreground_wait_elapsed' | 'background_immediately'
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
    ...(progress.agentType ? { agentType: progress.agentType } : {}),
    ...(progress.runId ? { runId: progress.runId } : {}),
    ...(progress.conversationId ? { conversationId: progress.conversationId } : {}),
    ...(progress.answerBridgeId ? { answerBridgeId: progress.answerBridgeId } : {}),
    message: reason === 'background_immediately'
      ? 'AgentRun 已启动并直接转入后台执行；稍后可用 answerBridgeId 读取提交内容。'
      : 'AgentRun 前台等待预算已用尽，已转入后台继续执行；稍后可用 answerBridgeId 读取提交内容。'
  };
  cmd.add(entity, ToolState, transitionToolState(started.state, 'success', { result, durationMs }, now));
  cmd.remove(entity, InFlight);
  spawnToolCallEvent(cmd, { toolCall: entity, toolCallId: call.id, kind: 'completed', status: 'success', at: now, elapsedMs: Math.max(0, now - call.createdAt), durationMs, payload: result });
}

function resolveRunAgentTargetByAnswerBridge(
  world: WorldReader,
  cmd: CommandSink,
  input: {
    blueprints: BuiltinAgentRegistry;
    answerBridgeId: string;
  }
): { ok: true; value: ResolvedRunAgentTarget } | { ok: false; reason: string } {
  const answerBridgeId = input.answerBridgeId.trim();
  if (!answerBridgeId) return { ok: false, reason: 'run_agent.answerBridgeId 不能为空。' };

  const bridgeSource = latestAnswerBridgeSourceById(world, answerBridgeId);
  if (!bridgeSource) {
    return { ok: false, reason: `未找到 answerBridgeId 绑定的子 Agent 对话：${answerBridgeId}` };
  }

  const target = runTarget(world, bridgeSource.run);
  if (!target) {
    return { ok: false, reason: `answerBridgeId 绑定的 AgentRun 没有目标 Agent/Conversation：${answerBridgeId}` };
  }

  const agentData = world.get(target.agent, Agent);
  const conversationData = world.get(target.conversation, Conversation);
  if (!agentData || !conversationData) {
    return { ok: false, reason: `answerBridgeId 绑定的子 Agent 对话数据不完整：${answerBridgeId}` };
  }

  ensureAgentConversationLink(world, cmd, target.agent, target.conversation, 'default');
  selectAgentForConversation(cmd, {
    agent: target.agent,
    conversation: target.conversation,
    conversationId: conversationData.id,
    agentId: agentData.id
  });

  const kind = world.get(target.agent, AgentKind)?.kind || agentData.id;
  const definition = resolveAgentDefinition(input.blueprints, kind)
    ?? resolveAgentDefinition(input.blueprints, agentData.id)
    ?? definitionFromExistingAgent(agentData, kind);

  return {
    ok: true,
    value: {
      targetAgent: target.agent,
      targetAgentId: agentData.id,
      targetAgentType: kind,
      definition,
      resolved: {
        ok: true,
        value: {
          conversation: target.conversation,
          conversationId: conversationData.id,
          policyMode: 'reuse_conversation',
          visibility: conversationData.visibility ?? 'collapsed'
        }
      }
    }
  };
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
  mode?: string;
  prompt?: string;
  answerBridgeId?: string;
  agent?: RunAgentAgentSelector;
  foregroundWaitMs?: number;
  wait?: string;
  scheduling?: string;
}

interface RunAgentAgentSelector {
  id?: string;
  type?: string;
}

interface RunAgentToolProgress {
  childRunId?: string;
  runId?: string;
  agentId?: string;
  agentType?: string;
  conversationId?: string;
  answerBridgeId?: string;
  foregroundWaitMs?: number;
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

function resolveTargetModeBlueprint(workflows: Record<string, BuiltinWorkflowDefinition>, workflowId: string | undefined): BuiltinWorkflowDefinition | undefined {
  if (!workflowId) return undefined;
  return workflows[workflowId] ?? Object.values(workflows).find((mode) => mode.id === workflowId || workflowId.endsWith(`:mode:${mode.id}`));
}

function resolveRunAgentPolicyDefaults(_definition: BuiltinAgentDefinition, _mode: BuiltinWorkflowDefinition | undefined): ResolvedRunAgentPolicyDefaults {
  return {
    conversationPolicy: { mode: 'new_conversation', visibility: 'collapsed' },
    contextPolicy: { historyMode: 'full' },
    deliveryPolicy: { mode: 'tool_response', includeTranscript: 'summary' },
    editPolicy: { onSourceEdited: 'mark_stale', onNewUserMessageWhileRunning: 'queue_next_run' }
  };
}

function normalizeRunAgentForegroundWaitMs(value: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { ok: false, reason: 'run_agent.foregroundWaitMs 为必填参数，需为非负毫秒数；0 表示启动后立即转后台。' };
  }
  return { ok: true, value: Math.floor(value) };
}

interface ResolvedRunAgentTarget {
  targetAgent: Entity;
  targetAgentId: string;
  targetAgentType: string;
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
        targetAgentType: kind,
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
      targetAgentType: targetKind,
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
  const configured = findAgentTypeBySelector(world, blueprints, selector);
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
  const typeAgent = findAgentTypeBySelector(world, blueprints, definition.id)
    ?? findAgentTypeBySelector(world, blueprints, definition.kind);
  const typeAgentData = typeAgent !== undefined ? world.get(typeAgent, Agent) : undefined;
  const typeId = typeAgentData?.id ?? definition.id;
  return { definition, typeId, ...(typeAgent !== undefined ? { typeAgent } : {}), ...(typeAgentData ? { typeAgentData } : {}) };
}

function findAgentTypeBySelector(world: WorldReader, blueprints: BuiltinAgentRegistry, selector: string): Entity | undefined {
  return world.query(Agent).find((entity) => {
    if (!isAvailableAgentTypeEntity(world, blueprints, entity)) return false;
    const agent = world.get(entity, Agent);
    const kind = world.get(entity, AgentKind)?.kind;
    return agent?.id === selector || kind === selector;
  });
}

function isAvailableAgentTypeEntity(world: WorldReader, blueprints: BuiltinAgentRegistry, entity: Entity): boolean {
  if (isTemporaryAgentEntity(world, entity)) return false;
  const agent = world.get(entity, Agent);
  if (!agent) return false;
  if (agent.source !== 'builtin') return true;
  const kind = world.get(entity, AgentKind)?.kind;
  return resolveAgentDefinition(blueprints, agent.id) !== undefined
    || (!!kind && resolveAgentDefinition(blueprints, kind) !== undefined);
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
    .filter((entity) => isAvailableAgentTypeEntity(world, blueprints, entity))
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

function executeRunAgentInterruptMode(
  world: WorldReader,
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  state: ToolStateData,
  authorization: Extract<AuthorizationResult, { ok: true }>,
  rawAnswerBridgeId: string | undefined
): void {
  const answerBridgeId = rawAnswerBridgeId?.trim();
  if (!answerBridgeId) {
    rejectToolCall(cmd, entity, call, state, 'run_agent.mode=interrupt 需要 answerBridgeId。');
    return;
  }

  const child = conversationForAnswerBridgeId(world, answerBridgeId);
  if (!child) {
    rejectToolCall(cmd, entity, call, state, `未找到 answerBridgeId 绑定的子 Agent 对话：${answerBridgeId}`);
    return;
  }
  const conversation = world.get(child.conversation, Conversation);
  if (!conversation) {
    rejectToolCall(cmd, entity, call, state, `answerBridgeId 绑定的子 Agent 对话数据不完整：${answerBridgeId}`);
    return;
  }

  const callerTarget = runTarget(world, authorization.run);
  if (callerTarget?.conversation === child.conversation) {
    rejectToolCall(cmd, entity, call, state, 'run_agent.mode=interrupt 不能中断当前工具调用所属的同一对话。');
    return;
  }

  const reason = `run_agent interrupt requested for ${answerBridgeId}`;
  const activeChildRunIds = child.activeRuns
    .map((run) => world.get(run, AgentRun)?.id)
    .filter((runId): runId is string => !!runId);
  // 与 run_agent 工具卡片的“中断”按钮复用同一条精确 Run 取消路径。
  for (const runId of activeChildRunIds) enqueueRunAgentTreeCancellation(cmd, runId, reason);
  const interruptRequested = activeChildRunIds.length > 0;

  // interrupted:true 是“当前工具调用被用户中断”的错误标记；这里成功完成的是
  // 中断请求本身，只能用 interruptRequested 描述对子 Run 发出的请求。
  completeInlineToolCallSuccess(cmd, entity, call, state, {
    ok: true,
    mode: 'interrupt',
    cascadeChildAgents: true,
    answerBridgeId,
    conversationId: conversation.id,
    status: interruptRequested ? 'interrupt_requested' : 'already_stopped',
    interruptRequested
  });
}

function executeRunAgentTool(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData, authorization: Extract<AuthorizationResult, { ok: true }>): void {
  let args: RunAgentArgs = {};
  try {
    args = call.argsJson ? JSON.parse(call.argsJson) as RunAgentArgs : {};
  } catch (error) {
    rejectToolCall(cmd, entity, call, state, `run_agent 参数不是合法 JSON: ${String(error)}`);
    return;
  }

  const mode = args.mode?.trim() || 'run';
  if (mode !== 'run' && mode !== 'interrupt') {
    rejectToolCall(cmd, entity, call, state, `run_agent.mode 不支持：${mode}`);
    return;
  }
  if (mode === 'interrupt') {
    executeRunAgentInterruptMode(world, cmd, entity, call, state, authorization, args.answerBridgeId);
    return;
  }

  const prompt = args.prompt?.trim();
  if (!prompt) {
    rejectToolCall(cmd, entity, call, state, 'run_agent 缺少必填 prompt。');
    return;
  }

  const foregroundWait = normalizeRunAgentForegroundWaitMs(args.foregroundWaitMs);
  if (!foregroundWait.ok) {
    rejectToolCall(cmd, entity, call, state, foregroundWait.reason);
    return;
  }

  const launched = launchChildAgentRun(world, cmd, {
    sourceRun: authorization.run,
    sourceRunId: authorization.runId,
    sourceToolCall: entity,
    sourceToolCallId: call.id,
    prompt,
    requestedAnswerBridgeId: args.answerBridgeId?.trim(),
    requestedAgentId: args.agent?.id?.trim(),
    requestedKind: args.agent?.type?.trim() || DEFAULT_RUN_AGENT_TYPE,
    foregroundWaitMs: foregroundWait.value,
    runKind: 'tool_invoked'
  });
  if (!launched.ok) {
    rejectToolCall(cmd, entity, call, state, launched.reason);
    return;
  }

  const { progress, deliveryMode, background } = launched.value;
  const now = progress.startedAt ?? Date.now();
  if (background) {
    completeRunAgentToolAsBackground(cmd, entity, call, state, progress, 'background_immediately');
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

interface LaunchChildAgentRunInput {
  sourceRun: Entity;
  sourceRunId: string;
  sourceToolCall: Entity;
  sourceToolCallId: string;
  prompt: string;
  requestedAnswerBridgeId?: string;
  requestedAgentId?: string;
  requestedKind: string;
  foregroundWaitMs: number;
  runKind: AgentRunKind;
}

interface LaunchChildAgentRunValue {
  progress: RunAgentToolProgress;
  deliveryMode: DeliveryMode;
  background: boolean;
}

function launchChildAgentRun(
  world: WorldReader,
  cmd: CommandSink,
  input: LaunchChildAgentRunInput
): { ok: true; value: LaunchChildAgentRunValue } | { ok: false; reason: string } {
  const parentTarget = runTarget(world, input.sourceRun);
  if (!parentTarget) return { ok: false, reason: '无法解析父 AgentRun 目标。' };

  const blueprints = world.getResource(AgentBlueprintsKey);
  const requestedAnswerBridgeId = input.requestedAnswerBridgeId?.trim();
  const resolvedTarget = requestedAnswerBridgeId
    ? resolveRunAgentTargetByAnswerBridge(world, cmd, {
      blueprints,
      answerBridgeId: requestedAnswerBridgeId
    })
    : resolveRunAgentTarget(world, cmd, {
      blueprints,
      requestedAgentId: input.requestedAgentId?.trim(),
      requestedKind: input.requestedKind,
      sourceConversation: parentTarget.conversation,
      toolCallEntity: input.sourceToolCall,
      prompt: input.prompt
    });
  if (!resolvedTarget.ok) return resolvedTarget;

  const { targetAgent, targetAgentId, targetAgentType, definition, resolved } = resolvedTarget.value;
  const policyDefaults = resolveRunAgentPolicyDefaults(definition, undefined);
  if (!resolved.ok) return resolved;

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
      sourceToolCall: input.sourceToolCall,
      sourceToolCallId: input.sourceToolCallId,
      sourceRun: input.sourceRun,
      sourceRunId: input.sourceRunId
    });
  }

  const reusedAnswerBridgeId = requestedAnswerBridgeId || answerBridgeIdForConversation(world, resolved.value.conversation);
  const answerBridgeId = reusedAnswerBridgeId ?? `agent-answer:${createMessageId()}`;
  const promptWithAnswerBridge = `${input.prompt}\n\n[Agent answer bridge]\n本次任务已${reusedAnswerBridgeId ? '沿用' : '分配'}默认 answerBridgeId：${answerBridgeId}。当你需要把阶段性结论或最终正文提交给来源 Agent 时，请调用 submit_agent_answer({ title, content })，未传 answerBridgeId 时会自动使用这个 answerBridgeId；即使本次 AgentRun 中断、重试或用户补充条件，只要继续在同一子对话中执行，默认值也应保持为这个 answerBridgeId；如果用户要求提交到其它 answerBridgeId，可显式传 submit_agent_answer({ answerBridgeId, title, content })。同一个 answerBridgeId 可以重复提交，每次提交都会通知来源 Agent。最终自然语言回复可以保持简短。`;
  const forcePromoteContinuation = !!reusedAnswerBridgeId && conversationHasActiveRun(world, resolved.value.conversation);
  const queuedInputContent: MessageContent = { role: 'user', parts: [{ text: promptWithAnswerBridge }] };
  const inputMessage = forcePromoteContinuation
    ? undefined
    : spawnUserMessage(cmd, resolved.value.conversation, promptWithAnswerBridge);
  const background = input.foregroundWaitMs === 0;
  const baseDeliveryPolicy: RunDeliveryPolicyBlueprint = {
    ...policyDefaults.deliveryPolicy,
    mode: background ? 'notification' : 'tool_response',
    includeTranscript: 'summary'
  };
  const deliveryMode = baseDeliveryPolicy.mode;
  const includeTranscript = baseDeliveryPolicy.includeTranscript;
  const childRun = spawnAgentRun(cmd, {
    kind: input.runKind,
    agent: targetAgent,
    conversation: resolved.value.conversation,
    sourceKind: 'toolCall',
    sourceAgent: parentTarget.agent,
    sourceConversation: parentTarget.conversation,
    sourceToolCall: input.sourceToolCall,
    sourceRun: input.sourceRun,
    answerBridgeId,
    ...(inputMessage !== undefined ? { inputMessage } : {}),
    ...(forcePromoteContinuation ? { needsModel: false, queuedInputContent, queueHoldReason: 'manual' as const } : {}),
    deliveryMode,
    includeTranscript
  });
  const inheritedWorkEnvironment = activeWorkEnvironmentForRun(world, input.sourceRun);
  if (inheritedWorkEnvironment) {
    selectConversationWorkEnvironment(world, cmd, resolved.value.conversation, inheritedWorkEnvironment.entity);
    selectRunWorkEnvironment(world, cmd, childRun, inheritedWorkEnvironment.entity);
  }
  applyRunConversationPolicy(cmd, childRun, resolved.value);
  applyRunContextPolicy(cmd, childRun, policyDefaults.contextPolicy);
  applyRunDeliveryPolicy(cmd, childRun, baseDeliveryPolicy);
  applyRunEditPolicy(cmd, childRun, policyDefaults.editPolicy);

  const childRunId = `run${childRun}`;
  if (forcePromoteContinuation) {
    // 与队列面板的“中断当前请求并发送队列”保持同一语义：续发内容先保持为
    // 暂停且未物化的排队输入，由 Promote 终止旧 Run、解除瞬时 hold 后再插入消息并启动新 Run。
    // hold 防止 QueueSystem 在 Promote 事件进入下一调度 pass 前抢先合并/激活该 Run；若直接附加
    // AgentRunNeedsModel，ContextAssembly 还会在旧 Run 仍运行时并发启动第二个响应。
    cmd.enqueue({
      type: AgentRunEventType.Promote,
      payload: { runId: childRunId, conversationId: resolved.value.conversationId }
    });
  }

  const now = Date.now();
  return {
    ok: true,
    value: {
      background,
      deliveryMode,
      progress: {
        childRunId,
        runId: childRunId,
        agentId: targetAgentId,
        agentType: targetAgentType,
        conversationId: resolved.value.conversationId,
        answerBridgeId,
        foregroundWaitMs: input.foregroundWaitMs,
        startedAt: now
      }
    }
  };
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
  selectDefaultWorkflowForConversation(cmd, conversation, conversationId);
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
    const planGate = authorizePlanReviewForTool(world, call, authorization);
    if (!planGate.ok) {
      rejectToolCall(cmd, entity, call, state, planGate.reason);
      handled.add(entity);
      continue;
    }
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
    const planGate = authorizePlanReviewForTool(world, call, authorization);
    if (!planGate.ok) {
      rejectToolCall(cmd, entity, call, state, planGate.reason);
      handled.add(entity);
      continue;
    }
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
  if (call.name === ASK_USER_TOOL_NAME || call.name === SUBMIT_PLAN_TOOL_NAME || isRunAgentInterruptCall(call)) return false;
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

function isRunAgentInterruptCall(call: ToolCallData): boolean {
  if (call.name !== RUN_AGENT_TOOL_NAME) return false;
  const args = parseToolCallArgs(call.argsJson);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const mode = (args as { mode?: unknown }).mode;
  return typeof mode === 'string' && mode.trim() === 'interrupt';
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
