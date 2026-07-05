import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Conversation, InFlight, LlmRequest, Message, Streaming } from '../../chat/components';
import { ToolCall, ToolState } from '../../tools/components';
import { spawnToolCallEvent, ToolCallEventBundle } from '../../tools/bundles';
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
  RunDeliveryPolicyLink,
  RunEditPolicyLink,
  RunModeLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  ToolCallRunLink,
  type AgentRunData
} from '../components';
import { AgentRunEventType } from '../events';
import { isTerminalRunStatus, runSource, runTarget } from '../queries';

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
    ToolCallRunLink,
    InFlight,
    RunModeLink,
    RunSystemPromptLink,
    RunModelProfileLink,
    RunToolPolicyLink,
    RunConversationPolicyLink,
    RunContextPolicyLink,
    RunDeliveryPolicyLink,
    RunEditPolicyLink,
    Conversation
  ],
  write: [AgentRun, AgentRunQueueHold, AgentRunQueueOrder, AgentRunQueuedInput, Message, ToolState],
  remove: [AgentRunQueueHold, AgentRunQueuedInput, AgentRunQueueOrder, AgentRunNeedsModel, Streaming, InFlight, LlmRequest],
  mutationMode: 'update',
  role: 'work'
});

export const AgentRunLifecycleSystem = defineSystem({
  name: 'AgentRunLifecycleSystem',
  access: {
    queries: [LifecycleRunsQuery],
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
    effects: { emit: ['llm.abort'] },
    bundles: [AgentRunBundle, ToolCallEventBundle]
  },
  run(ctx) {
    const { world, cmd } = ctx;

    for (const payload of readEvents(ctx, AgentRunEventType.Cancel)) {
      const run = findRunById(world, payload.runId);
      if (run !== undefined) terminateRun(world, cmd, run, 'cancelled', 'cancelled_by_user', 'cancelled', payload.reason ?? 'Run cancelled by user.');
    }

    for (const payload of readEvents(ctx, AgentRunEventType.CancelConversation)) {
      for (const run of activeRunsForConversation(world, payload.conversationId)) {
        terminateRun(world, cmd, run, 'cancelled', 'cancelled_by_user', 'cancelled', payload.reason ?? 'Conversation active run cancelled.');
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

  const nextRun = spawnAgentRun(cmd, {
    kind: data.kind as AgentRunKind,
    agent: target.agent,
    conversation: target.conversation,
    sourceKind: source?.sourceKind ?? 'agentRun',
    ...(source?.sourceAgent !== undefined ? { sourceAgent: source.sourceAgent } : {}),
    ...(source?.sourceConversation !== undefined ? { sourceConversation: source.sourceConversation } : {}),
    ...(source?.sourceMessage !== undefined ? { sourceMessage: source.sourceMessage, inputMessage: source.sourceMessage } : {}),
    ...(source?.sourceToolCall !== undefined ? { sourceToolCall: source.sourceToolCall } : {}),
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
  message: string
): void {
  const data = world.get(run, AgentRun);
  if (!data || isTerminalRunStatus(data.status)) return;
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
  failOpenToolCalls(world, cmd, run, message);
}

function promoteRun(world: WorldReader, cmd: CommandSink, runId: string, conversationId: string): void {
  const targetRun = findRunById(world, runId);
  if (targetRun === undefined) return;
  const targetData = world.get(targetRun, AgentRun);
  if (!targetData || targetData.status !== 'queued') return;
  const target = runTarget(world, targetRun);
  const targetConversation = target ? world.get(target.conversation, Conversation) : undefined;
  if (!target || targetConversation?.id !== conversationId) return;

  // 取消当前正在执行的（非 queued、非终态）run
  const activeRuns = activeRunsForConversation(world, conversationId);
  for (const run of activeRuns) {
    if (run === targetRun) continue;
    const data = world.get(run, AgentRun);
    if (!data || data.status === 'queued' || isTerminalRunStatus(data.status)) continue;
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

function failOpenToolCalls(world: WorldReader, cmd: CommandSink, run: Entity, reason: string): void {
  const now = Date.now();
  for (const entity of world.query(ToolCall, ToolState, ToolCallRunLink)) {
    if (world.get(entity, ToolCallRunLink)?.run !== run) continue;
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);
    if (!call || !state || isTerminalToolStatus(state.status)) continue;
    cmd.add(entity, ToolState, transitionToolState(state, 'error', { error: reason, result: { error: reason }, durationMs: Math.max(0, now - call.createdAt) }, now));
    cmd.remove(entity, InFlight);
    spawnToolCallEvent(cmd, {
      toolCall: entity,
      toolCallId: call.id,
      kind: 'failed',
      status: 'error',
      at: now,
      elapsedMs: Math.max(0, now - call.createdAt),
      durationMs: Math.max(0, now - call.createdAt),
      error: reason,
      payload: { reason }
    });
  }
}

function cloneRunOverrides(world: WorldReader, cmd: CommandSink, sourceRun: Entity, targetRun: Entity): void {
  const now = Date.now();
  cloneRunModeLinks(world, cmd, sourceRun, targetRun, now);
  cloneRunEntityLinks(world, cmd, sourceRun, targetRun, RunSystemPromptLink, 'systemPrompt', 'run-system-prompt-clone', now);
  cloneRunEntityLinks(world, cmd, sourceRun, targetRun, RunModelProfileLink, 'modelProfile', 'run-model-profile-clone', now);
  cloneRunEntityLinks(world, cmd, sourceRun, targetRun, RunToolPolicyLink, 'toolPolicy', 'run-tool-policy-clone', now);
  cloneRunPolicyLinks(world, cmd, sourceRun, targetRun, RunConversationPolicyLink, 'run-conversation-policy-clone', now);
  cloneRunPolicyLinks(world, cmd, sourceRun, targetRun, RunContextPolicyLink, 'run-context-policy-clone', now);
  cloneRunPolicyLinks(world, cmd, sourceRun, targetRun, RunDeliveryPolicyLink, 'run-delivery-policy-clone', now);
  cloneRunPolicyLinks(world, cmd, sourceRun, targetRun, RunEditPolicyLink, 'run-edit-policy-clone', now);
}

function cloneRunModeLinks(world: WorldReader, cmd: CommandSink, sourceRun: Entity, targetRun: Entity, now: number): void {
  for (const entity of world.query(RunModeLink)) {
    const link = world.get(entity, RunModeLink);
    if (!link || link.run !== sourceRun || link.role !== 'active') continue;
    const clone = cmd.spawn();
    cmd.add(clone, RunModeLink, { id: `run-mode-clone:${targetRun}:${clone}`, run: targetRun, mode: link.mode, role: 'active', createdAt: now, updatedAt: now });
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
