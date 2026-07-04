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
import { ToolCall, ToolCallEvent, ToolPolicyScopeLink, ToolResultConsumed, ToolState, type ToolCallData, type ToolStateData } from '../components';
import { ToolEventType } from '../events';
import { isTerminalToolStatus, toolStateToResponse, transitionToolState } from '../state';
import { simplifyToolResponseForModel } from '../responseSimplifier';
import { readEvents } from '../../../events';
import type { ContentPart, InlineDataPart, LlmInvocationSettingsSnapshotRecord, LlmUsageMetadataRecord, ToolCallStatus } from '../../../../../shared/protocol';
import { isFunctionResponsePart, isInlineDataPart } from '../../../../../shared/protocol';
import { CheckpointEventType } from '../../checkpoint/events';
import { CompressionBlock } from '../../compression/components';
import { CompressionEventType } from '../../compression/events';
import { LlmInvocation, RunLlmInvocationLink, type LlmInvocationData } from '../../llm/components';
import { isYoloToolPolicy } from '../policy';

const AUTO_COMPRESSION_DEBUG_PREFIX = '[LimCode][AutoCompressionDebug]';

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
    reads: { components: [LlmInvocation, RunLlmInvocationLink, ToolCallEvent, CompressionBlock] },
    writes: { components: [AgentRun, AgentRunNeedsModel, MessageRunLink, ToolState] },
    events: { read: [ToolEventType.ResultSubmitRequested, ToolEventType.ResultRejectRequested], emit: [CheckpointEventType.Requested, CompressionEventType.Create] }
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

      const conversationData = world.get(target.conversation, Conversation);
      const toolResponse = toolStateToResponse(state);
      const simplifiedResponse = simplifyToolResponseForModel(call.name, state.status, toolResponse);
      const inlineParts = inlinePartsFromToolResponse(toolResponse);
      const responseMessage = spawnToolResponseMessage(cmd, {
        conversation: target.conversation,
        toolCallId: call.functionCallId ?? call.id,
        toolName: call.name,
        status: state.status,
        response: simplifiedResponse,
        parts: inlineParts,
        durationMs: state.durationMs
      });
      debugAutoCompression('tool.response.spawned', {
        runId: runData.id,
        conversationId: conversationData?.id,
        toolCallId: call.id,
        functionCallId: call.functionCallId,
        toolName: call.name,
        status: state.status,
        responseMessageEntity: responseMessage,
        expectedResponseMessageId: `m${responseMessage}`,
        partKinds: describeToolResponsePartKinds(call.functionCallId ?? call.id, call.name, simplifiedResponse, inlineParts)
      });
      spawnMessageRunLink(cmd, { message: responseMessage, run, role: 'tool_response' });
      cmd.add(entity, ToolResultConsumed, true);
      consumedThisPass.add(entity);
      touchedRuns.add(run);
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
        maybeEnqueueAutoCompressionAfterToolResponses(world, cmd, {
          conversation: target.conversation,
          conversationId: conversationData.id,
          run,
          runId: runData.id,
          responseMessageId: `m${responseMessage}`,
          consumedThisPass
        });
      }
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

function maybeEnqueueAutoCompressionAfterToolResponses(
  world: WorldReader,
  cmd: CommandSink,
  input: { conversation: Entity; conversationId: string; run: Entity; runId: string; responseMessageId: string; consumedThisPass: ReadonlySet<Entity> }
): void {
  if (hasPendingToolWork(world, input.run, input.consumedThisPass)) {
    debugAutoCompression('tool.response.skipPendingToolWork', { conversationId: input.conversationId, runId: input.runId, responseMessageId: input.responseMessageId });
    return;
  }

  const settings = latestInvocationSettingsForRun(world, input.run);
  const trigger = settings?.compressionTrigger;
  if (!settings || !trigger || trigger.mode !== 'token_threshold' || settings.compressionMethodKind === 'disabled') return;

  const observedTokens = latestObservedTokensForRun(world, input.run);
  const thresholdTokens = autoCompressionThresholdTokens(settings);
  debugAutoCompression('tool.response.check', {
    conversationId: input.conversationId,
    runId: input.runId,
    responseMessageId: input.responseMessageId,
    methodKind: settings.compressionMethodKind,
    compressionConfigId: settings.compressionConfigId,
    observedTokens,
    thresholdTokens
  });
  if (observedTokens === undefined || thresholdTokens === undefined || observedTokens < thresholdTokens) return;
  if (hasCompressionBlockForAnchor(world, input.conversation, input.responseMessageId)) {
    debugAutoCompression('tool.response.skipDuplicateAnchor', { conversationId: input.conversationId, responseMessageId: input.responseMessageId });
    return;
  }

  debugAutoCompression('tool.response.enqueue', {
    conversationId: input.conversationId,
    runId: input.runId,
    endMessageId: input.responseMessageId,
    methodKind: settings.compressionMethodKind,
    compressionConfigId: settings.compressionConfigId
  });
  cmd.enqueue({
    type: CompressionEventType.Create,
    payload: {
      conversationId: input.conversationId,
      endMessageId: input.responseMessageId,
      ...(settings.compressionConfigId ? { methodConfigId: settings.compressionConfigId } : {}),
      ...(settings.compressionMethodKind ? { methodKind: settings.compressionMethodKind } : {}),
      trigger: 'auto' as const
    }
  });
}

function requiresResultSubmitApproval(world: WorldReader, run: Entity, toolName: string, state: ToolStateData): boolean {
  if (hasResultSubmitDecision(state)) return false;
  const policy = activeToolPolicyForRun(world, run);
  if (isYoloToolPolicy(policy)) return false;
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

function latestInvocationSettingsForRun(world: WorldReader, run: Entity): LlmInvocationSettingsSnapshotRecord | undefined {
  return latestInvocationForRun(world, run)?.settings;
}

function latestObservedTokensForRun(world: WorldReader, run: Entity): number | undefined {
  const invocation = latestInvocationForRun(world, run);
  return invocation?.usageMetadata ? usageTokenCount(invocation.usageMetadata) : undefined;
}

function latestInvocationForRun(world: WorldReader, run: Entity): LlmInvocationData | undefined {
  let latest: { invocation: LlmInvocationData; invocationCreatedAt: number; linkCreatedAt: number; linkId: string } | undefined;
  for (const entity of world.query(RunLlmInvocationLink)) {
    const link = world.get(entity, RunLlmInvocationLink);
    if (!link || link.run !== run) continue;
    const invocation = world.get(link.invocation, LlmInvocation);
    if (!invocation) continue;
    const candidate = { invocation, invocationCreatedAt: invocation.createdAt, linkCreatedAt: link.createdAt, linkId: link.id };
    if (!latest
      || candidate.invocationCreatedAt > latest.invocationCreatedAt
      || (candidate.invocationCreatedAt === latest.invocationCreatedAt && candidate.linkCreatedAt > latest.linkCreatedAt)
      || (candidate.invocationCreatedAt === latest.invocationCreatedAt && candidate.linkCreatedAt === latest.linkCreatedAt && candidate.linkId > latest.linkId)) {
      latest = candidate;
    }
  }
  return latest?.invocation;
}

function autoCompressionThresholdTokens(settings: LlmInvocationSettingsSnapshotRecord): number | undefined {
  const trigger = settings.compressionTrigger;
  if (!trigger) return undefined;
  const contextWindowTokens = finitePositiveNumber(settings.contextWindowTokens);
  const thresholdPercent = finitePositiveNumber(trigger.thresholdPercent);
  return finitePositiveNumber(trigger.thresholdTokens)
    ?? (contextWindowTokens !== undefined && thresholdPercent !== undefined
      ? Math.floor(contextWindowTokens * Math.min(100, thresholdPercent) / 100)
      : undefined);
}

function usageTokenCount(usage: LlmUsageMetadataRecord): number | undefined {
  const total = finitePositiveNumber(usage.totalTokenCount);
  if (total !== undefined) return total;
  const prompt = finitePositiveNumber(usage.promptTokenCount) ?? 0;
  const candidates = finitePositiveNumber(usage.candidatesTokenCount) ?? 0;
  const thoughts = finitePositiveNumber(usage.thoughtsTokenCount) ?? 0;
  const sum = prompt + candidates + thoughts;
  return sum > 0 ? sum : undefined;
}

function finitePositiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function hasCompressionBlockForAnchor(world: WorldReader, conversation: Entity, anchorMessageId: string): boolean {
  return world.query(CompressionBlock).some((entity) => {
    const block = world.get(entity, CompressionBlock);
    return block?.conversation === conversation
      && block.anchorMessageId === anchorMessageId
      && (block.status === 'running' || block.status === 'pending' || block.status === 'complete');
  });
}


function debugAutoCompression(stage: string, payload: Record<string, unknown>): void {
  void stage;
  void payload;
}

function describeToolResponsePartKinds(toolCallId: string, toolName: string, response: unknown, inlineParts: InlineDataPart[] | undefined): string[] {
  const parts: ContentPart[] = [{
    id: toolCallId,
    functionResponse: { name: toolName, response, ...(inlineParts?.length ? { parts: inlineParts } : {}) }
  }];
  return parts.map((part) => {
    if (isFunctionResponsePart(part)) return `functionResponse:${part.functionResponse.name}`;
    if (isInlineDataPart(part)) return `inlineData:${part.inlineData.mimeType}`;
    return Object.keys(part)[0] ?? 'unknown';
  });
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
