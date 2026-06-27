import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { Agent, AgentConversationLink } from '../../agent/components';
import {
  AgentRun,
  AgentRunNeedsModel,
  AgentRunTargetLink,
  MessageRunLink,
  RunModeLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from '../../agentRun/components';
import { markRunNeedsModel, spawnMessageRunLink } from '../../agentRun/bundles';
import { activeToolPolicyForRun, runForToolCall, runTarget } from '../../agentRun/queries';
import { Conversation } from '../../chat/components';
import { spawnToolResponseMessage, ToolResultMessageBundle } from '../../chat/bundles';
import { ConversationModeSelection, Mode, ToolPolicy } from '../../mode/components';
import { ToolCallEventBundle, spawnToolCallEvent } from '../bundles';
import { ToolCall, ToolPolicyScopeLink, ToolResultConsumed, ToolState, type ToolCallData, type ToolStateData } from '../components';
import { ToolEventType } from '../events';
import { isTerminalToolStatus, toolStateToResponse, transitionToolState } from '../state';
import { simplifyToolResponseForModel } from '../responseSimplifier';
import { readEvents } from '../../../events';
import type { InlineDataPart, ToolCallStatus } from '../../../../../shared/protocol';
import { CheckpointEventType } from '../../checkpoint/events';

const SettledToolCallsQuery = defineQuery({
  name: 'SettledToolCalls',
  all: [ToolCall, ToolState],
  none: [ToolResultConsumed],
  read: [
    ToolCall,
    ToolState,
    ToolCallRunLink,
    AgentRun,
    AgentRunTargetLink,
    Agent,
    AgentConversationLink,
    Conversation,
    ConversationModeSelection,
    Mode,
    ToolPolicy,
    ToolPolicyScopeLink,
    RunModeLink,
    RunToolPolicyLink
  ],
  write: [ToolState],
  add: [ToolResultConsumed],
  mutationMode: 'update',
  role: 'work'
});

const ActiveToolWorkLookupQuery = defineQuery({
  name: 'ActiveToolWorkLookup',
  all: [ToolCall, ToolState],
  read: [ToolCall, ToolState, ToolCallRunLink, ToolResultConsumed],
  role: 'lookup'
});

export const ToolResultSystem = defineSystem({
  name: 'ToolResultSystem',
  access: {
    queries: [SettledToolCallsQuery, ActiveToolWorkLookupQuery],
    bundles: [ToolResultMessageBundle, ToolCallEventBundle],
    writes: { components: [AgentRun, AgentRunNeedsModel, MessageRunLink, ToolState] },
    events: { read: [ToolEventType.ResultSubmitRequested, ToolEventType.ResultRejectRequested], emit: [CheckpointEventType.Requested] }
  },
  run(ctx) {
    const { world, cmd } = ctx;

    for (const payload of readEvents(ctx, ToolEventType.ResultSubmitRequested)) {
      const entity = findToolCallById(world, payload.toolCallId);
      const call = entity === undefined ? undefined : world.get(entity, ToolCall);
      const state = entity === undefined ? undefined : world.get(entity, ToolState);
      if (entity === undefined || !call || !state || state.status !== 'awaiting_result_submit') continue;
      const nextStatus = pendingResultSubmitStatus(state) ?? 'success';
      const now = Date.now();
      cmd.add(entity, ToolState, transitionToolState(state, nextStatus, { progress: { resultSubmitApproved: true } }, now));
      spawnToolCallEvent(cmd, {
        toolCall: entity,
        toolCallId: call.id,
        kind: 'state',
        status: nextStatus,
        at: now,
        elapsedMs: Math.max(0, now - call.createdAt),
        payload: { approved: true, reason: payload.reason }
      });
    }

    for (const payload of readEvents(ctx, ToolEventType.ResultRejectRequested)) {
      const entity = findToolCallById(world, payload.toolCallId);
      const call = entity === undefined ? undefined : world.get(entity, ToolCall);
      const state = entity === undefined ? undefined : world.get(entity, ToolState);
      if (entity === undefined || !call || !state || state.status !== 'awaiting_result_submit') continue;
      const reason = payload.reason?.trim() || '用户拒绝使用工具结果。';
      const now = Date.now();
      cmd.add(entity, ToolState, transitionToolState(state, 'error', { error: reason, result: { denied: true, reason }, progress: { resultSubmitApproved: true }, durationMs: state.durationMs }, now));
      spawnToolCallEvent(cmd, {
        toolCall: entity,
        toolCallId: call.id,
        kind: 'failed',
        status: 'error',
        at: now,
        elapsedMs: Math.max(0, now - call.createdAt),
        durationMs: state.durationMs,
        payload: { denied: true, reason },
        error: reason
      });
    }

    const settled = world
      .query(ToolCall, ToolState)
      .filter((entity) => {
        const state = world.get(entity, ToolState);
        return !!state && isTerminalToolStatus(state.status) && !world.has(entity, ToolResultConsumed) && runForToolCall(world, entity) !== undefined;
      });
    if (settled.length === 0) return;

    const touchedRuns = new Set<Entity>();
    const consumedThisPass = new Set<Entity>();
    for (const entity of settled) {
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      const run = runForToolCall(world, entity);
      if (!call || !state || run === undefined || !isTerminalToolStatus(state.status)) continue;
      const runData = world.get(run, AgentRun);
      if (!runData || isTerminalRunStatus(runData.status)) continue;
      const target = runTarget(world, run);
      if (!target) continue;

      if (requiresResultSubmitApproval(world, run, call.name, state)) {
        awaitResultSubmit(world, cmd, entity, call, state);
        continue;
      }

      const toolResponse = toolStateToResponse(state);
      const responseMessage = spawnToolResponseMessage(cmd, {
        conversation: target.conversation,
        toolCallId: call.functionCallId ?? call.id,
        toolName: call.name,
        status: state.status,
        response: simplifyToolResponseForModel(call.name, state.status, toolResponse),
        parts: inlinePartsFromToolResponse(toolResponse),
        durationMs: state.durationMs
      });
      spawnMessageRunLink(cmd, { message: responseMessage, run, role: 'tool_response' });
      const conversationData = world.get(target.conversation, Conversation);
      if (conversationData) {
        cmd.enqueue({
          type: CheckpointEventType.Requested,
          payload: {
            conversationId: conversationData.id,
            runId: runData.id,
            toolCallId: call.id,
            toolName: call.name,
            anchorPosition: 'after',
            trigger: 'tool_execution_after'
          }
        });
      }
      cmd.add(entity, ToolResultConsumed, true);
      consumedThisPass.add(entity);
      touchedRuns.add(run);
    }

    for (const run of touchedRuns) {
      if (!hasPendingToolWork(world, run, consumedThisPass)) {
        const runData = world.get(run, AgentRun);
        if (runData) {
          cmd.add(run, AgentRun, { ...runData, status: 'running', updatedAt: Date.now() });
        }
        markRunNeedsModel(cmd, run);
      }
    }
  }
});

function requiresResultSubmitApproval(world: WorldReader, run: Entity, toolName: string, state: ToolStateData): boolean {
  if (hasResultSubmitDecision(state)) return false;
  const policy = activeToolPolicyForRun(world, run);
  return policy?.toolConfigs?.[toolName]?.autoSubmitResult === false;
}

function awaitResultSubmit(world: WorldReader, cmd: CommandSink, entity: Entity, call: ToolCallData, state: ToolStateData): void {
  const now = Date.now();
  const next = transitionToolState(state, 'awaiting_result_submit', { progress: { pendingResultSubmitStatus: state.status }, durationMs: state.durationMs }, now);
  cmd.add(entity, ToolState, next);
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'state',
    status: 'awaiting_result_submit',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    durationMs: state.durationMs,
    payload: { pendingResultSubmitStatus: state.status }
  });
}

function pendingResultSubmitStatus(state: ToolStateData): Extract<ToolCallStatus, 'success' | 'warning' | 'error'> | undefined {
  const progress = state.progress;
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return undefined;
  const status = (progress as { pendingResultSubmitStatus?: unknown }).pendingResultSubmitStatus;
  return status === 'success' || status === 'warning' || status === 'error' ? status : undefined;
}

function hasResultSubmitDecision(state: ToolStateData): boolean {
  const progress = state.progress;
  return !!progress && typeof progress === 'object' && !Array.isArray(progress) && (progress as { resultSubmitApproved?: unknown }).resultSubmitApproved === true;
}

function findToolCallById(world: WorldReader, toolCallId: string): Entity | undefined {
  return world.query(ToolCall, ToolState).find((entity) => world.get(entity, ToolCall)?.id === toolCallId);
}

function hasPendingToolWork(world: WorldReader, run: Entity, consumedThisPass: ReadonlySet<Entity>): boolean {
  return world.query(ToolCall, ToolState).some((entity) => {
    if (runForToolCall(world, entity) !== run) return false;
    const state = world.get(entity, ToolState);
    if (!state) return false;
    const fullySettled = isTerminalToolStatus(state.status) && (world.has(entity, ToolResultConsumed) || consumedThisPass.has(entity));
    return !fullySettled;
  });
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stale';
}


function inlinePartsFromToolResponse(value: unknown): InlineDataPart[] | undefined {
  const record = asRecord(value);
  const parts = Array.isArray(record?.parts) ? record.parts : undefined;
  if (!parts) return undefined;
  const result: InlineDataPart[] = [];
  for (const item of parts) {
    const part = asRecord(item);
    const inlineData = asRecord(part?.inlineData);
    if (typeof inlineData?.mimeType !== 'string') continue;
    result.push({ inlineData: { ...inlineData, mimeType: inlineData.mimeType } as InlineDataPart['inlineData'] });
  }
  return result.length > 0 ? result : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
