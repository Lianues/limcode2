import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Conversation, InFlight, LlmRequest, Message, Streaming } from '../../chat/components';
import { ToolCall, ToolResultConsumed, ToolState, type ToolCallData, type ToolStateData } from '../../tools/components';
import { ToolCallEventBundle, spawnToolCallEvent } from '../../tools/bundles';
import { interruptToolCall } from '../../tools/interrupt';
import { activeExecutionBatchForRun } from '../../tools/scheduling';
import { ToolDefinitionsKey, ToolRuntimeDefinitionsKey } from '../../tools/resources';
import { isTerminalToolStatus, transitionToolState } from '../../tools/state';
import type { AgentRunEndReason, AgentRunErrorType, AgentRunKind, AgentRunQueueHoldReason, MessageContent, QueueInputUpdatePayload } from '../../../../../shared/protocol';
import { AgentRunBundle, markRunNeedsModel, spawnAgentRun } from '../bundles';
import { cleanupRunLlmRequests, type RunLlmCleanupReason } from '../llmRequestCleanup';
import {
  AgentRun,
  AgentRunNeedsModel,
  AgentRunQueueHold,
  AgentRunQueueOrder,
  AgentRunQueuedInput,
  AgentRunSourceLink,
  AgentRunTargetLink,
  RunContextPolicyLink,
  RunConversationPolicyLink,
  RunDeliveryPolicy,
  RunDeliveryPolicyLink,
  RunEditPolicyLink,
  RunWorkflowLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  ToolCallRunLink,
  type AgentRunData
} from '../components';
import { AgentRunEventType } from '../events';
import { answerBridgeIdForConversation, childRunsForRun, isTerminalRunStatus, runSource, runTarget } from '../queries';
import { RUN_AGENT_TOOL_NAME } from '../../tools/definitions/runAgent';
import { activeWorkEnvironmentForRun } from '../../workEnvironment/queries';
import { RunWorkEnvironmentLink, WorkEnvironment } from '../../workEnvironment/components';
import { isRemoteServerWorkEnvironmentKind } from '../../../../../shared/workEnvironmentCatalog';

const LifecycleRunsQuery = defineQuery({
  name: 'AgentRunLifecycle',
  all: [AgentRun],
  read: [
    AgentRun,
    AgentRunNeedsModel,
    AgentRunSourceLink,
    AgentRunTargetLink,
    AgentRunQueueHold,
    AgentRunQueueOrder,
    AgentRunQueuedInput,

    LlmRequest,
    Message,
    Streaming,
    ToolCall,
    ToolState,
    ToolResultConsumed,
    ToolCallRunLink,
    InFlight,
    RunWorkflowLink,
    RunSystemPromptLink,
    RunModelProfileLink,
    RunToolPolicyLink,
    RunConversationPolicyLink,
    RunContextPolicyLink,
    RunDeliveryPolicy,
    RunDeliveryPolicyLink,
    RunEditPolicyLink,
    RunWorkEnvironmentLink,
    WorkEnvironment,
    Conversation
  ],
  write: [AgentRun, AgentRunQueueHold, AgentRunQueueOrder, AgentRunQueuedInput, Message, ToolState, RunDeliveryPolicy],
  remove: [AgentRunQueueHold, AgentRunQueuedInput, AgentRunQueueOrder, AgentRunNeedsModel, Streaming, InFlight, LlmRequest],
  mutationMode: 'update',
  role: 'work'
});

export const AgentRunLifecycleSystem = defineSystem({
  name: 'AgentRunLifecycleSystem',
  access: {
    queries: [LifecycleRunsQuery],
    resources: { read: [ToolDefinitionsKey, ToolRuntimeDefinitionsKey] },
    events: {
      read: [
        AgentRunEventType.Cancel,
        AgentRunEventType.CancelConversation,
        AgentRunEventType.Pause,
        AgentRunEventType.Resume,
        AgentRunEventType.Retry,
        AgentRunEventType.Regenerate,
        AgentRunEventType.MarkStale,
        AgentRunEventType.Promote,
        AgentRunEventType.RemoveQueued,
        AgentRunEventType.ReorderQueue,
        AgentRunEventType.PauseQueue,
        AgentRunEventType.ResumeQueue,
        AgentRunEventType.ResumeQueueConversation,
        AgentRunEventType.UpdateQueuedInput
      ]
    },
    effects: { emit: ['llm.abort', 'tool.abort', 'tool.background'] },
    bundles: [AgentRunBundle, ToolCallEventBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;

    for (const payload of readEvents(ctx, AgentRunEventType.Cancel)) {
      const run = findRunById(world, payload.runId);
      if (run !== undefined) {
        cancelRunCascade(world, cmd, run, 'cancelled_by_user', payload.reason ?? 'Run cancelled by user.', new Set(), {
          cascadeChildAgents: payload.cascadeChildAgents === true
        });
      }
    }

    for (const payload of readEvents(ctx, AgentRunEventType.CancelConversation)) {
      const seen = new Set<Entity>();
      for (const run of activeRunsForConversation(world, payload.conversationId)) {
        cancelRunCascade(world, cmd, run, 'cancelled_by_user', payload.reason ?? 'Conversation active run cancelled.', seen, {
          cascadeChildAgents: payload.cascadeChildAgents === true
        });
      }
    }

    for (const payload of readEvents(ctx, AgentRunEventType.Promote)) {
      promoteRun(world, cmd, payload.runId, payload.conversationId);
    }

    for (const payload of readEvents(ctx, AgentRunEventType.ReorderQueue)) {
      reorderQueue(world, cmd, payload.conversationId, payload.runIds);
    }

    for (const payload of readEvents(ctx, AgentRunEventType.RemoveQueued)) {
      removeQueuedRun(world, cmd, payload.conversationId, payload.runId);
    }

    for (const payload of readEvents(ctx, AgentRunEventType.PauseQueue)) {
      holdQueuedRun(world, cmd, payload.conversationId, payload.runId, payload.reason ?? 'manual');
    }

    for (const payload of readEvents(ctx, AgentRunEventType.ResumeQueue)) {
      releaseQueuedRun(world, cmd, payload.conversationId, payload.runId);
    }

    for (const payload of readEvents(ctx, AgentRunEventType.ResumeQueueConversation)) {
      releaseQueuedRunsForConversation(world, cmd, payload.conversationId);
    }

    for (const payload of readEvents(ctx, AgentRunEventType.UpdateQueuedInput)) {
      updateQueuedInput(world, cmd, payload.conversationId, payload.runId, normalizeQueuedInputContent(payload));
    }

    for (const payload of readEvents(ctx, AgentRunEventType.MarkStale)) {
      const run = findRunById(world, payload.runId);
      if (run !== undefined) terminateRun(world, cmd, run, 'stale', 'stale_source_edited', 'stale', payload.reason ?? 'Run marked stale.');
    }

    for (const payload of readEvents(ctx, AgentRunEventType.Pause)) {
      const run = findRunById(world, payload.runId);
      if (run !== undefined) pauseRun(world, cmd, run);
    }

    for (const payload of readEvents(ctx, AgentRunEventType.Resume)) {
      const run = findRunById(world, payload.runId);
      if (run !== undefined) resumeRun(world, cmd, run);
    }

    for (const payload of readEvents(ctx, AgentRunEventType.Retry)) {
      const run = findRunById(world, payload.runId);
      if (run !== undefined) retryRun(world, cmd, run, 'retry_requested');
    }

    for (const payload of readEvents(ctx, AgentRunEventType.Regenerate)) {
      const run = findRunById(world, payload.runId);
      if (run !== undefined) retryRun(world, cmd, run, 'regenerate_requested');
    }
  }
});

function pauseRun(world: WorldReader, cmd: CommandSink, run: Entity): void {
  const data = world.get(run, AgentRun);
  if (!data || isTerminalRunStatus(data.status) || data.status === 'paused') return;
  cmd.add(run, AgentRun, { ...data, status: 'paused', updatedAt: Date.now() });
  cleanupLlmRequests(world, cmd, run, { kind: 'paused' });
}

function resumeRun(world: WorldReader, cmd: CommandSink, run: Entity): void {
  const data = world.get(run, AgentRun);
  if (!data || data.status !== 'paused') return;
  cmd.add(run, AgentRun, { ...data, status: 'running', updatedAt: Date.now() });
  markRunNeedsModel(cmd, run);
}

function retryRun(world: WorldReader, cmd: CommandSink, run: Entity, reason: Extract<AgentRunEndReason, 'retry_requested' | 'regenerate_requested'>): void {
  const data = world.get(run, AgentRun);
  const target = runTarget(world, run);
  if (!data || !target) return;
  const source = runSource(world, run);
  const wasTerminal = isTerminalRunStatus(data.status);
  if (!wasTerminal) {
    terminateRun(world, cmd, run, 'cancelled', reason, 'cancelled', reason === 'retry_requested' ? 'Run retry requested.' : 'Run regenerate requested.');
  } else {
    cmd.add(run, AgentRun, { ...data, endReason: reason, updatedAt: Date.now(), completedAt: data.completedAt ?? Date.now() });
  }

  const answerBridgeId = source?.answerBridgeId?.trim() || answerBridgeIdForConversation(world, target.conversation);
  const nextRun = spawnAgentRun(cmd, {
    kind: data.kind as AgentRunKind,
    agent: target.agent,
    conversation: target.conversation,
    sourceKind: source?.sourceKind ?? 'agentRun',
    ...(source?.sourceAgent !== undefined ? { sourceAgent: source.sourceAgent } : {}),
    ...(source?.sourceConversation !== undefined ? { sourceConversation: source.sourceConversation } : {}),
    ...(source?.sourceMessage !== undefined ? { sourceMessage: source.sourceMessage, inputMessage: source.sourceMessage } : {}),
    ...(source?.sourceToolCall !== undefined ? { sourceToolCall: source.sourceToolCall } : {}),
    ...(answerBridgeId ? { answerBridgeId } : {}),
    sourceRun: run,
    retryOfRunId: data.id,
    attempt: (data.attempt ?? 1) + 1,
    deliveryMode: 'direct_reply',
    includeTranscript: 'summary'
  });
  cloneRunOverrides(world, cmd, run, nextRun);
}

function terminateRun(
  world: WorldReader,
  cmd: CommandSink,
  run: Entity,
  status: Extract<AgentRunData['status'], 'cancelled' | 'stale'>,
  endReason: AgentRunEndReason,
  errorType: AgentRunErrorType,
  message: string,
  options: { backgroundedToolCalls?: ReadonlySet<Entity> } = {}
): void {
  const data = world.get(run, AgentRun);
  if (!data || isTerminalRunStatus(data.status)) return;
  const backgroundedToolCalls = options.backgroundedToolCalls
    ?? (endReason === 'cancelled_by_user' ? backgroundForegroundWaitingToolsInActiveBatch(world, cmd, run) : new Set<Entity>());
  const now = Date.now();
  cmd.add(run, AgentRun, {
    ...data,
    status,
    updatedAt: now,
    completedAt: now,
    endReason,
    errorType,
    error: message
  });
  removeQueueArtifactsForRun(world, cmd, run);
  cleanupLlmRequests(world, cmd, run, cleanupReasonForEndReason(endReason));
  failOpenToolCalls(world, cmd, run, backgroundedToolCalls);
}

/**
 * 取消一个 run，并只取消仍与当前执行链路强绑定的子 run。
 *
 * run_agent / shell 等工具一旦已经向父 run 返回“已后台执行/已完成工具响应”，工具状态就是终态；
 * 此后对应后台 Agent / 后台进程已经脱离当前对话的中断按钮，不应再被全局中断牵连。
 * 若它们仍在当前执行批次中前台等待，则先主动转后台再终止父 run；不在当前批次或尚未启动的工具仍按中断处理。
 */
interface CancelRunCascadeOptions {
  /** 显式终止子 Agent 树时，不把当前批次的 run_agent 转后台，并穿透已终态中间节点递归取消所有后代。 */
  cascadeChildAgents: boolean;
}

function cancelRunCascade(
  world: WorldReader,
  cmd: CommandSink,
  run: Entity,
  endReason: AgentRunEndReason,
  message: string,
  seen: Set<Entity> = new Set(),
  options: CancelRunCascadeOptions = { cascadeChildAgents: false }
): void {
  if (seen.has(run)) return;
  seen.add(run);
  const data = world.get(run, AgentRun);
  const runIsActive = !!data && !isTerminalRunStatus(data.status);
  // 普通停止/插队：当前批次的 run_agent 先转后台并脱离父 Run。
  // 显式 cancel-tree（run_agent interrupt / 单工具取消）：run_agent 不后台化，所有后代 AgentRun 都递归取消。
  const backgroundedToolCalls = runIsActive
    ? backgroundForegroundWaitingToolsInActiveBatch(world, cmd, run, { backgroundRunAgentTools: !options.cascadeChildAgents })
    : new Set<Entity>();
  const children: Entity[] = [];
  for (const child of childRunsForRun(world, run)) {
    if (options.cascadeChildAgents) {
      children.push(child);
      continue;
    }
    const sourceToolCall = runSource(world, child)?.sourceToolCall;
    if (sourceToolCall !== undefined && backgroundedToolCalls.has(sourceToolCall)) {
      seen.add(child);
      continue;
    }
    if (shouldCascadeCancellationToChildRun(world, child)) children.push(child);
  }
  terminateRun(world, cmd, run, 'cancelled', endReason, 'cancelled', message, { backgroundedToolCalls });
  for (const child of children) {
    cancelRunCascade(world, cmd, child, endReason, message, seen, options);
  }
}

function shouldCascadeCancellationToChildRun(world: WorldReader, childRun: Entity): boolean {
  const source = runSource(world, childRun);
  if (source?.sourceToolCall === undefined) return true;
  const state = world.get(source.sourceToolCall, ToolState);
  return !!state && !isTerminalToolStatus(state.status);
}

function promoteRun(world: WorldReader, cmd: CommandSink, runId: string, conversationId: string): void {
  const targetRun = findRunById(world, runId);
  if (targetRun === undefined) return;
  const targetData = world.get(targetRun, AgentRun);
  if (!targetData || targetData.status !== 'queued') return;
  const target = runTarget(world, targetRun);
  const targetConversation = target ? world.get(target.conversation, Conversation) : undefined;
  if (!target || targetConversation?.id !== conversationId) return;

  // 取消当前正在执行的 run。普通 queued run（没有 NeedsModel）仍保留，稍后会和目标消息一起批量物化；
  // queued + NeedsModel 已进入直接启动链路，必须视为活跃 run 终止，否则 Promote 后两者会并发请求模型。
  const activeRuns = activeRunsForConversation(world, conversationId);
  for (const run of activeRuns) {
    if (run === targetRun) continue;
    const data = world.get(run, AgentRun);
    if (!data || isTerminalRunStatus(data.status)) continue;
    if (data.status === 'queued' && !world.has(run, AgentRunNeedsModel)) continue;
    terminateRun(world, cmd, run, 'cancelled', 'cancelled_by_user', 'cancelled', 'Force send: cancelled for promotion.');
  }

  const queuedRuns = queuedRunsForConversation(world, conversationId);
  const minOrder = Math.min(...queuedRuns.map((run) => queueSortKey(world, run).order), queueSortKey(world, targetRun).order);
  removeQueueHoldForRun(world, cmd, targetRun);
  upsertQueueOrder(world, cmd, targetRun, target.conversation, minOrder - 1000);
}

function reorderQueue(world: WorldReader, cmd: CommandSink, conversationId: string, runIds: string[]): void {
  const conversation = findConversationById(world, conversationId);
  if (conversation === undefined) return;

  const queuedRuns = queuedRunsForConversation(world, conversationId).sort((left, right) => compareRunsByQueueOrder(world, left, right));
  if (queuedRuns.length === 0) return;

  const queuedById = new Map<string, Entity>();
  for (const run of queuedRuns) {
    const data = world.get(run, AgentRun);
    if (data) queuedById.set(data.id, run);
  }

  const seen = new Set<Entity>();
  const orderedRuns: Entity[] = [];
  for (const runId of runIds) {
    const run = queuedById.get(runId);
    if (run === undefined || seen.has(run)) continue;
    orderedRuns.push(run);
    seen.add(run);
  }

  for (const run of queuedRuns) {
    if (!seen.has(run)) orderedRuns.push(run);
  }

  const now = Date.now();
  for (let index = 0; index < orderedRuns.length; index += 1) {
    upsertQueueOrder(world, cmd, orderedRuns[index], conversation, (index + 1) * 1000, now);
  }
}

function queuedRunsForConversation(world: WorldReader, conversationId: string): Entity[] {
  return activeRunsForConversation(world, conversationId).filter((run) => world.get(run, AgentRun)?.status === 'queued');
}

function compareRunsByQueueOrder(world: WorldReader, left: Entity, right: Entity): number {
  const leftKey = queueSortKey(world, left);
  const rightKey = queueSortKey(world, right);
  return leftKey.order - rightKey.order || leftKey.createdAt - rightKey.createdAt || left - right;
}

function queueSortKey(world: WorldReader, run: Entity): { order: number; createdAt: number } {
  const data = world.get(run, AgentRun);
  const order = queueOrderEntityForRun(world, run);
  const createdAt = data?.createdAt ?? 0;
  return { order: order !== undefined ? world.get(order, AgentRunQueueOrder)?.order ?? createdAt : createdAt, createdAt };
}

function upsertQueueOrder(world: WorldReader, cmd: CommandSink, run: Entity, conversation: Entity, order: number, timestamp = Date.now()): void {
  const entity = queueOrderEntityForRun(world, run);
  if (entity !== undefined) {
    const current = world.get(entity, AgentRunQueueOrder);
    if (!current) return;
    cmd.add(entity, AgentRunQueueOrder, { ...current, conversation, order, updatedAt: timestamp });
    return;
  }

  const created = cmd.spawn();
  cmd.add(created, AgentRunQueueOrder, {
    id: `arqo${created}`,
    run,
    conversation,
    order,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function queueOrderEntityForRun(world: WorldReader, run: Entity): Entity | undefined {
  return world.query(AgentRunQueueOrder).find((entity) => world.get(entity, AgentRunQueueOrder)?.run === run);
}

function normalizeQueuedInputContent(payload: QueueInputUpdatePayload): MessageContent {
  if (payload.content?.parts?.length) return { role: 'user', parts: payload.content.parts };
  const text = payload.text?.trim() ?? '';
  return { role: 'user', parts: text ? [{ text }] : [] };
}

function updateQueuedInput(world: WorldReader, cmd: CommandSink, conversationId: string, runId: string, content: MessageContent): void {
  if (content.parts.length === 0) return;
  const target = queuedRunInConversation(world, conversationId, runId);
  if (!target) return;
  const inputEntity = queuedInputEntityForRun(world, target.run);
  if (inputEntity === undefined) return;
  const current = world.get(inputEntity, AgentRunQueuedInput);
  if (!current) return;
  cmd.add(inputEntity, AgentRunQueuedInput, { ...current, content, updatedAt: Date.now() });
}

function queuedInputEntityForRun(world: WorldReader, run: Entity): Entity | undefined {
  return world.query(AgentRunQueuedInput).find((entity) => world.get(entity, AgentRunQueuedInput)?.run === run);
}

function removeQueuedRun(world: WorldReader, cmd: CommandSink, conversationId: string, runId: string): void {
  const target = queuedRunInConversation(world, conversationId, runId);
  if (!target) return;
  terminateRun(world, cmd, target.run, 'cancelled', 'cancelled_by_user', 'cancelled', 'Queued run removed by user.');
}

function removeQueueArtifactsForRun(world: WorldReader, cmd: CommandSink, run: Entity): void {
  removeQueueHoldForRun(world, cmd, run);
  const input = queuedInputEntityForRun(world, run);
  if (input !== undefined) cmd.remove(input, AgentRunQueuedInput);
  const order = queueOrderEntityForRun(world, run);
  if (order !== undefined) cmd.remove(order, AgentRunQueueOrder);
}




function holdQueuedRun(world: WorldReader, cmd: CommandSink, conversationId: string, runId: string, reason: AgentRunQueueHoldReason): void {
  const target = queuedRunInConversation(world, conversationId, runId);
  if (!target) return;
  upsertQueueHold(world, cmd, target.run, target.conversation, reason);
}

function releaseQueuedRun(world: WorldReader, cmd: CommandSink, conversationId: string, runId: string): void {
  const target = queuedRunInConversation(world, conversationId, runId);
  if (!target) return;
  removeQueueHoldForRun(world, cmd, target.run);
}

function releaseQueuedRunsForConversation(world: WorldReader, cmd: CommandSink, conversationId: string): void {
  for (const run of queuedRunsForConversation(world, conversationId)) {
    removeQueueHoldForRun(world, cmd, run);
  }
}

function queuedRunInConversation(world: WorldReader, conversationId: string, runId: string): { run: Entity; conversation: Entity } | undefined {
  const run = findRunById(world, runId);
  if (run === undefined) return undefined;
  const data = world.get(run, AgentRun);
  if (!data || data.status !== 'queued') return undefined;
  const target = runTarget(world, run);
  const conversation = target ? world.get(target.conversation, Conversation) : undefined;
  if (!target || conversation?.id !== conversationId) return undefined;
  return { run, conversation: target.conversation };
}

function upsertQueueHold(world: WorldReader, cmd: CommandSink, run: Entity, conversation: Entity, reason: AgentRunQueueHoldReason, timestamp = Date.now()): void {
  const entity = queueHoldEntityForRun(world, run);
  if (entity !== undefined) {
    const current = world.get(entity, AgentRunQueueHold);
    if (!current) return;
    cmd.add(entity, AgentRunQueueHold, { ...current, conversation, reason, updatedAt: timestamp });
    return;
  }

  const created = cmd.spawn();
  cmd.add(created, AgentRunQueueHold, {
    id: `arqh${created}`,
    run,
    conversation,
    reason,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function removeQueueHoldForRun(world: WorldReader, cmd: CommandSink, run: Entity): void {
  const entity = queueHoldEntityForRun(world, run);
  if (entity !== undefined) cmd.remove(entity, AgentRunQueueHold);
}

function queueHoldEntityForRun(world: WorldReader, run: Entity): Entity | undefined {
  return world.query(AgentRunQueueHold).find((entity) => world.get(entity, AgentRunQueueHold)?.run === run);
}

function cleanupLlmRequests(world: WorldReader, cmd: CommandSink, run: Entity, reason: RunLlmCleanupReason): void {
  cmd.remove(run, AgentRunNeedsModel);
  cleanupRunLlmRequests(world, cmd, run, reason);
}

function cleanupReasonForEndReason(endReason: AgentRunEndReason): RunLlmCleanupReason {
  switch (endReason) {
    case 'retry_requested':
      return { kind: 'retry_replaced' };
    case 'regenerate_requested':
      return { kind: 'regenerate_replaced' };
    case 'stale_source_edited':
      return { kind: 'stale' };
    case 'cancelled_by_user':
    case 'cancelled_by_policy':
    default:
      return { kind: 'user_cancelled' };
  }
}

interface ForegroundRunAgentProgress {
  runId?: string;
  agentId?: string;
  agentType?: string;
  conversationId?: string;
  answerBridgeId?: string;
  foregroundWaitMs?: number;
  startedAt?: number;
}

/**
 * 仅后台化当前执行批次里已经启动、且具备前台等待语义的 shell/bash 与 run_agent。
 * 不在 active batch 中的后续工具以及尚未启动的工具不会在这里执行，随后由 failOpenToolCalls 标记为中断。
 */
function backgroundForegroundWaitingToolsInActiveBatch(
  world: WorldReader,
  cmd: CommandSink,
  run: Entity,
  options: { backgroundRunAgentTools: boolean } = { backgroundRunAgentTools: true }
): Set<Entity> {
  const backgrounded = new Set<Entity>();
  const batch = activeExecutionBatchForRun(world, run);
  if (!batch) return backgrounded;

  for (const entity of batch.calls) {
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);
    if (!call || !state || state.status !== 'executing' || !world.has(entity, InFlight)) continue;

    if (call.name === RUN_AGENT_TOOL_NAME) {
      if (options.backgroundRunAgentTools && backgroundForegroundRunAgentTool(world, cmd, entity, call, state)) {
        backgrounded.add(entity);
      }
      continue;
    }

    if ((call.name === 'shell' || call.name === 'bash') && isBackgroundableForegroundCommand(world, run, call)) {
      cmd.effect({ kind: 'tool.background', toolCallId: call.id });
      backgrounded.add(entity);
    }
  }

  return backgrounded;
}

function isBackgroundableForegroundCommand(world: WorldReader, run: Entity, call: ToolCallData): boolean {
  const args = parseToolArgs(call.argsJson);
  const mode = args.mode === 'output' || args.mode === 'kill' ? args.mode : 'execute';
  if (mode !== 'execute') return false;
  const foregroundWaitMs = args.foregroundWaitMs;
  if (typeof foregroundWaitMs !== 'number' || !Number.isFinite(foregroundWaitMs) || foregroundWaitMs < 0) return false;
  const workEnvironment = activeWorkEnvironmentForRun(world, run)?.data;
  return !workEnvironment || !isRemoteServerWorkEnvironmentKind(workEnvironment.kind);
}

function backgroundForegroundRunAgentTool(
  world: WorldReader,
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  state: ToolStateData
): boolean {
  const progress = foregroundRunAgentProgress(state.progress);
  if (progress.foregroundWaitMs === undefined || progress.foregroundWaitMs < 0 || !progress.runId) return false;
  const childRun = findRunById(world, progress.runId);
  const childData = childRun !== undefined ? world.get(childRun, AgentRun) : undefined;
  if (childRun === undefined || !childData || isTerminalRunStatus(childData.status)) return false;

  setRunDeliveryToNotification(world, cmd, childRun);
  const now = Date.now();
  const startedAt = progress.startedAt ?? call.createdAt;
  const durationMs = Math.max(0, now - startedAt);
  const result = {
    ok: true,
    status: 'backgrounded',
    reason: 'parent_run_interrupted',
    ...(progress.agentId ? { agentId: progress.agentId } : {}),
    ...(progress.agentType ? { agentType: progress.agentType } : {}),
    runId: progress.runId,
    ...(progress.conversationId ? { conversationId: progress.conversationId } : {}),
    ...(progress.answerBridgeId ? { answerBridgeId: progress.answerBridgeId } : {}),
    message: '父 AgentRun 即将中断，子 AgentRun 已立即转入后台继续执行。'
  };
  cmd.add(entity, ToolState, transitionToolState(state, 'success', { result, durationMs }, now));
  cmd.remove(entity, InFlight);
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
  return true;
}

function foregroundRunAgentProgress(value: unknown): ForegroundRunAgentProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    runId: typeof record.runId === 'string' ? record.runId : undefined,
    agentId: typeof record.agentId === 'string' ? record.agentId : undefined,
    agentType: typeof record.agentType === 'string' ? record.agentType : undefined,
    conversationId: typeof record.conversationId === 'string' ? record.conversationId : undefined,
    answerBridgeId: typeof record.answerBridgeId === 'string' ? record.answerBridgeId : undefined,
    foregroundWaitMs: typeof record.foregroundWaitMs === 'number' && Number.isFinite(record.foregroundWaitMs) ? record.foregroundWaitMs : undefined,
    startedAt: typeof record.startedAt === 'number' && Number.isFinite(record.startedAt) ? record.startedAt : undefined
  };
}

function setRunDeliveryToNotification(world: WorldReader, cmd: CommandSink, run: Entity): void {
  const linkEntity = world.query(RunDeliveryPolicyLink).find((entity) => {
    const link = world.get(entity, RunDeliveryPolicyLink);
    return link?.run === run && link.role === 'active';
  });
  const link = linkEntity !== undefined ? world.get(linkEntity, RunDeliveryPolicyLink) : undefined;
  const policy = link ? world.get(link.policy, RunDeliveryPolicy) : undefined;
  if (link && policy) {
    cmd.add(link.policy, RunDeliveryPolicy, { ...policy, mode: 'notification', includeTranscript: policy.includeTranscript ?? 'summary' });
    return;
  }

  const now = Date.now();
  const policyEntity = cmd.spawn();
  cmd.add(policyEntity, RunDeliveryPolicy, { id: `run-interrupt-delivery:${run}:${policyEntity}`, mode: 'notification', includeTranscript: 'summary' });
  const policyLink = cmd.spawn();
  cmd.add(policyLink, RunDeliveryPolicyLink, {
    id: `run-interrupt-delivery-link:${run}:${policyLink}`,
    run,
    policy: policyEntity,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
}

function parseToolArgs(argsJson: string): Record<string, unknown> {
  try {
    const value = argsJson ? JSON.parse(argsJson) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function failOpenToolCalls(world: WorldReader, cmd: CommandSink, run: Entity, backgroundedToolCalls: ReadonlySet<Entity> = new Set()): void {
  // ToolCallRunLink 是独立实体（toolCall/run 是其字段），不与 ToolCall/ToolState 同实体，
  // 因此必须先按 run 收集 toolCall 实体集合，再遍历工具调用——不能三组件同实体 query（永远为空）。
  const toolCallEntitiesInRun = new Set(
    world
      .query(ToolCallRunLink)
      .filter((entity) => world.get(entity, ToolCallRunLink)?.run === run)
      .map((entity) => world.get(entity, ToolCallRunLink)?.toolCall)
      .filter((entity): entity is Entity => entity !== undefined)
  );
  for (const entity of world.query(ToolCall, ToolState)) {
    if (!toolCallEntitiesInRun.has(entity) || backgroundedToolCalls.has(entity)) continue;
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);
    if (!call || !state) continue;
    // 统一标记为“被用户中断执行”，并对仍在途的运行时工具尽力 emit tool.abort 真中断。
    interruptToolCall(cmd, entity, call, state, { emitAbort: true });
  }
}

function cloneRunOverrides(world: WorldReader, cmd: CommandSink, sourceRun: Entity, targetRun: Entity): void {
  const now = Date.now();
  cloneRunWorkflowLinks(world, cmd, sourceRun, targetRun, now);
  cloneRunEntityLinks(world, cmd, sourceRun, targetRun, RunSystemPromptLink, 'systemPrompt', 'run-system-prompt-clone', now);
  cloneRunEntityLinks(world, cmd, sourceRun, targetRun, RunModelProfileLink, 'modelProfile', 'run-model-profile-clone', now);
  cloneRunEntityLinks(world, cmd, sourceRun, targetRun, RunToolPolicyLink, 'toolPolicy', 'run-tool-policy-clone', now);
  cloneRunPolicyLinks(world, cmd, sourceRun, targetRun, RunConversationPolicyLink, 'run-conversation-policy-clone', now);
  cloneRunPolicyLinks(world, cmd, sourceRun, targetRun, RunContextPolicyLink, 'run-context-policy-clone', now);
  cloneRunPolicyLinks(world, cmd, sourceRun, targetRun, RunDeliveryPolicyLink, 'run-delivery-policy-clone', now);
  cloneRunPolicyLinks(world, cmd, sourceRun, targetRun, RunEditPolicyLink, 'run-edit-policy-clone', now);
}

function cloneRunWorkflowLinks(world: WorldReader, cmd: CommandSink, sourceRun: Entity, targetRun: Entity, now: number): void {
  for (const entity of world.query(RunWorkflowLink)) {
    const link = world.get(entity, RunWorkflowLink);
    if (!link || link.run !== sourceRun || link.role !== 'active') continue;
    const clone = cmd.spawn();
    cmd.add(clone, RunWorkflowLink, { id: `run-workflow-clone:${targetRun}:${clone}`, run: targetRun, workflow: link.workflow, role: 'active', createdAt: now, updatedAt: now });
  }
}

function cloneRunEntityLinks(
  world: WorldReader,
  cmd: CommandSink,
  sourceRun: Entity,
  targetRun: Entity,
  component: { id: symbol },
  field: string,
  idPrefix: string,
  now: number
): void {
  for (const entity of world.query(component as never)) {
    const link = world.get(entity, component as never) as { run: Entity; role: 'active'; [key: string]: unknown } | undefined;
    if (!link || link.run !== sourceRun || link.role !== 'active') continue;
    const target = link[field] as Entity | undefined;
    if (target === undefined) continue;
    const clone = cmd.spawn();
    cmd.add(clone, component as never, { id: `${idPrefix}:${targetRun}:${clone}`, run: targetRun, [field]: target, role: 'active', createdAt: now, updatedAt: now } as never);
  }
}

function cloneRunPolicyLinks(world: WorldReader, cmd: CommandSink, sourceRun: Entity, targetRun: Entity, component: { id: symbol }, idPrefix: string, now: number): void {
  for (const entity of world.query(component as never)) {
    const link = world.get(entity, component as never) as { run: Entity; policy: Entity; role: 'active' } | undefined;
    if (!link || link.run !== sourceRun || link.role !== 'active') continue;
    const clone = cmd.spawn();
    cmd.add(clone, component as never, { id: `${idPrefix}:${targetRun}:${clone}`, run: targetRun, policy: link.policy, role: 'active', createdAt: now, updatedAt: now } as never);
  }
}

function findRunById(world: WorldReader, runId: string): Entity | undefined {
  return world.query(AgentRun).find((entity) => world.get(entity, AgentRun)?.id === runId);
}

function findConversationById(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}

function activeRunsForConversation(world: WorldReader, conversationId: string): Entity[] {
  return world.query(AgentRun).filter((run) => {
    const data = world.get(run, AgentRun);
    const target = runTarget(world, run);
    const conversation = target ? world.get(target.conversation, Conversation) : undefined;
    return !!data && !!conversation && conversation.id === conversationId && !isTerminalRunStatus(data.status);
  });
}
