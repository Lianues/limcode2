import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Conversation, InFlight, LlmRequest, Message, Streaming } from '../../chat/components';
import { ToolCall, ToolState } from '../../tools/components';
import { spawnToolCallEvent, ToolCallEventBundle } from '../../tools/bundles';
import { isTerminalToolStatus, transitionToolState } from '../../tools/state';
import type { AgentRunEndReason, AgentRunErrorType, AgentRunKind } from '../../../../../shared/protocol';
import { AgentRunBundle, markRunNeedsModel, spawnAgentRun } from '../bundles';
import { cleanupRunLlmRequests } from '../llmRequestCleanup';
import {
  AgentRun,
  AgentRunNeedsModel,
  AgentRunSourceLink,
  AgentRunTargetLink,
  RunApprovalPolicyLink,
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
import { runSource, runTarget } from '../queries';

const LifecycleRunsQuery = defineQuery({
  name: 'AgentRunLifecycle',
  all: [AgentRun],
  read: [
    AgentRun,
    AgentRunNeedsModel,
    AgentRunSourceLink,
    AgentRunTargetLink,
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
    RunApprovalPolicyLink,
    RunConversationPolicyLink,
    RunContextPolicyLink,
    RunDeliveryPolicyLink,
    RunEditPolicyLink,
    Conversation
  ],
  write: [AgentRun, Message, ToolState],
  remove: [AgentRunNeedsModel, Streaming, InFlight, LlmRequest],
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
        AgentRunEventType.MarkStale
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
  cleanupLlmRequests(world, cmd, run, 'Run paused.');
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
  cleanupLlmRequests(world, cmd, run, message);
  failOpenToolCalls(world, cmd, run, message);
}

function cleanupLlmRequests(world: WorldReader, cmd: CommandSink, run: Entity, message: string): void {
  cmd.remove(run, AgentRunNeedsModel);
  cleanupRunLlmRequests(world, cmd, run, message);
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
  cloneRunEntityLinks(world, cmd, sourceRun, targetRun, RunApprovalPolicyLink, 'approvalPolicy', 'run-approval-policy-clone', now);
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

function activeRunsForConversation(world: WorldReader, conversationId: string): Entity[] {
  return world.query(AgentRun).filter((run) => {
    const data = world.get(run, AgentRun);
    const target = runTarget(world, run);
    const conversation = target ? world.get(target.conversation, Conversation) : undefined;
    return !!data && !!conversation && conversation.id === conversationId && !isTerminalRunStatus(data.status);
  });
}

function isTerminalRunStatus(status: AgentRunData['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stale';
}
