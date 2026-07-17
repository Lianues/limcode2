import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import type { LlmModelSettings } from '../../llm/contracts';
import { LlmEventType, type LlmInvocationResolvedPayload, type LlmInvocationResolveErrorPayload } from '../../llm/events';
import { AgentRun, AgentRunNeedsModel, AgentRunQueueHold, AgentRunQueuedInput, AgentRunQueueOrder, AgentRunTargetLink, MessageRunLink, RunWorkflowLink, RunModelProfileLink } from '../../agentRun/components';
import { spawnMessageRunLink } from '../../agentRun/bundles';
import { activeModelProfileForRun, isTerminalRunStatus } from '../../agentRun/queries';
import { CompressionBlock } from '../../compression/components';
import { hasActiveBlockingCompression } from '../../compression/queries';
import { ConversationWorkflowSelection, Workflow, ModelProfile, ModelProfileScopeLink } from '../../workflow/components';
import { LlmRequest, Conversation, ConversationFullContextLoaded, ConversationFullContextPending, Message } from '../components';
import { ModelMessageBundle, LlmRequestBundle, MessageBundle, spawnMessage, spawnModelMessage, spawnLlmRequest } from '../bundles';
import { materializeUserInputMessage } from '../userInputMaterialization';
import { CheckpointEventType } from '../../checkpoint/events';
import { spawnCheckpointBarrier } from '../../checkpoint/barriers';
import { Checkpoint, CheckpointBarrier } from '../../checkpoint/components';
import { LlmInvocation, MessageLlmInvocationLink, RunLlmInvocationLink } from '../../llm/components';
import { LlmInvocationBundle, MessageLlmInvocationLinkBundle, spawnLlmInvocation, spawnMessageLlmInvocationLink, spawnRunLlmInvocationLink } from '../../llm/bundles';
import { createMessageId } from '../../../../../shared/protocol';

const RunsNeedingModelQuery = defineQuery({
  name: 'RunsNeedingModel',
  all: [AgentRun, AgentRunNeedsModel],
  read: [AgentRun, AgentRunNeedsModel, AgentRunQueueHold, AgentRunQueuedInput, AgentRunQueueOrder, AgentRunTargetLink, LlmRequest, Conversation, ConversationFullContextLoaded, ConversationFullContextPending, Message, Checkpoint, CheckpointBarrier],
  write: [AgentRun, ConversationFullContextPending],
  remove: [AgentRunNeedsModel, AgentRunQueuedInput, AgentRunQueueOrder, AgentRunQueueHold],
  mutationMode: 'update',
  role: 'work'
});

const ActiveLlmRequestsQuery = defineQuery({
  name: 'ActiveLlmRequests',
  all: [LlmRequest],
  read: [LlmRequest],
  role: 'lookup'
});

const LlmInvocationLookupQuery = defineQuery({
  name: 'LlmInvocationLookup',
  all: [LlmInvocation],
  read: [LlmInvocation, RunLlmInvocationLink, MessageLlmInvocationLink],
  write: [LlmInvocation],
  mutationMode: 'update',
  role: 'lookup'
});

export const ContextAssemblySystem = defineSystem({
  name: 'ContextAssemblySystem',
  access: {
    queries: [RunsNeedingModelQuery, ActiveLlmRequestsQuery, LlmInvocationLookupQuery],
    reads: { components: [RunWorkflowLink, RunModelProfileLink, ConversationWorkflowSelection, Workflow, ModelProfile, ModelProfileScopeLink, CompressionBlock, ConversationFullContextLoaded, ConversationFullContextPending, AgentRunQueueHold, AgentRunQueuedInput, AgentRunQueueOrder, Checkpoint] },
    bundles: [ModelMessageBundle, MessageBundle, LlmRequestBundle, LlmInvocationBundle, MessageLlmInvocationLinkBundle],
    writes: { components: [AgentRun, MessageRunLink, ConversationFullContextPending, CheckpointBarrier] },
    events: { read: [LlmEventType.InvocationResolved, LlmEventType.InvocationResolveError], emit: [CheckpointEventType.Requested] },
    effects: { emit: ['conversation.context.load', 'llm.resolveInvocation'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const event of ctx.events) {
      switch (event.type) {
        case LlmEventType.InvocationResolved:
          materializeResolvedInvocation(world, cmd, event.payload as LlmInvocationResolvedPayload);
          break;
        case LlmEventType.InvocationResolveError:
          materializeInvocationResolveError(world, cmd, event.payload as LlmInvocationResolveErrorPayload);
          break;
      }
    }

    for (const run of world.query(AgentRun, AgentRunNeedsModel)) {
      if (hasActiveRequest(world, run) || hasActiveInvocation(world, run)) {
        cmd.remove(run, AgentRunNeedsModel);
        continue;
      }
      const target = targetForRun(world, run);
      if (!target) continue;
      if (!world.has(target.conversation, ConversationFullContextLoaded)) {
        requestFullContextLoad(world, cmd, run, target.conversation);
        continue;
      }
      if (hasActiveBlockingCompression(world, target.conversation)) continue;

      drainQueuedInputsIntoRun(world, cmd, run, target.conversation);

      const invocation = spawnLlmInvocation(cmd);
      const invocationId = spawnedInvocationId(invocation);
      const requestId = spawnedInvocationRequestId(invocation);
      spawnRunLlmInvocationLink(cmd, { run, invocation });
      const conversation = world.get(target.conversation, Conversation);
      cmd.effect({
        kind: 'llm.resolveInvocation',
        invocationId,
        requestId,
        ...(conversation ? { conversationId: conversation.id } : {}),
        ...modelSettingsForRun(world, run)
      });
      markRunRunning(world, cmd, run);
      cmd.remove(run, AgentRunNeedsModel);
    }
  }
});

function requestFullContextLoad(world: WorldReader, cmd: CommandSink, run: Entity, conversation: Entity): void {
  markRunPreparing(world, cmd, run);
  if (world.has(conversation, ConversationFullContextPending)) return;
  const data = world.get(conversation, Conversation);
  if (!data?.id) return;
  cmd.add(conversation, ConversationFullContextPending, { startedAt: Date.now() });
  cmd.effect({ kind: 'conversation.context.load', conversationId: data.id });
}

function markRunPreparing(world: WorldReader, cmd: CommandSink, run: Entity): void {
  const data = world.get(run, AgentRun);
  if (!data || data.status !== 'queued') return;
  cmd.add(run, AgentRun, { ...data, status: 'preparing', updatedAt: Date.now() });
}

function materializeResolvedInvocation(world: WorldReader, cmd: CommandSink, payload: LlmInvocationResolvedPayload): void {
  const invocation = invocationEntityById(world, payload.invocationId);
  if (invocation === undefined) return;
  const current = world.get(invocation, LlmInvocation);
  if (!current) return;

  const run = runForInvocation(world, invocation);
  if (run === undefined) return;
  const target = targetForRun(world, run);
  if (!target) return;

  // run 已被取消/终止（例如用户在“整理中”这段发起中断）时，别再落地 invocation、也别创建空的
  // pre-start model 消息——否则那条 streaming/空 model 消息会让“少女整理中”指示器一直挂到下次真正调用 LLM。
  const runData = world.get(run, AgentRun);
  if (runData && isTerminalRunStatus(runData.status)) {
    cmd.add(invocation, LlmInvocation, { ...current, status: 'cancelled', resolvedAt: payload.resolvedAt, completedAt: payload.resolvedAt });
    return;
  }

  cmd.add(invocation, LlmInvocation, {
    ...current,
    status: 'ready',
    settings: payload.settings,
    resolvedAt: payload.resolvedAt
  });

  if (messageForInvocation(world, invocation) !== undefined) return;
  const modelMessage = spawnModelMessage(cmd, target.conversation, payload.settings.displayModelName ?? payload.settings.modelName ?? payload.settings.modelId);
  spawnMessageRunLink(cmd, { message: modelMessage, run, role: 'model' });
  spawnMessageLlmInvocationLink(cmd, { message: modelMessage, invocation });
  const request = spawnLlmRequest(cmd, { run, conversation: target.conversation, modelMessage, invocation, requestId: payload.requestId });
  requestLlmResponseBeforeCheckpoint(world, cmd, run, target.conversation, modelMessage, request, payload.requestId);
}

function materializeInvocationResolveError(world: WorldReader, cmd: CommandSink, payload: LlmInvocationResolveErrorPayload): void {
  const invocation = invocationEntityById(world, payload.invocationId);
  if (invocation === undefined) return;
  const current = world.get(invocation, LlmInvocation);
  if (!current) return;

  cmd.add(invocation, LlmInvocation, {
    ...current,
    status: 'error',
    error: payload.message,
    resolvedAt: payload.resolvedAt,
    completedAt: payload.resolvedAt
  });

  if (messageForInvocation(world, invocation) !== undefined) return;
  const run = runForInvocation(world, invocation);
  if (run === undefined) return;
  const target = targetForRun(world, run);
  if (!target) return;

  // run 已被取消/终止时不再落地错误消息、也不覆盖其终态。
  const runDataBefore = world.get(run, AgentRun);
  if (runDataBefore && isTerminalRunStatus(runDataBefore.status)) return;

  const modelMessage = spawnMessage(cmd, { parent: target.conversation, role: 'model', parts: [{ text: `\n[error] ${payload.message}` }], status: 'error' });
  spawnMessageRunLink(cmd, { message: modelMessage, run, role: 'model' });
  spawnMessageLlmInvocationLink(cmd, { message: modelMessage, invocation });
  const runData = world.get(run, AgentRun);
  if (runData) {
    cmd.add(run, AgentRun, { ...runData, status: 'failed', error: payload.message, errorType: 'llm', endReason: 'failed', completedAt: payload.resolvedAt, updatedAt: payload.resolvedAt });
  }
}

function modelSettingsForRun(world: WorldReader, run: Entity): { model?: LlmModelSettings } {
  const modelProfile = activeModelProfileForRun(world, run);
  return modelProfile === undefined
    ? {}
    : { model: { providerConfigId: modelProfile.providerConfigId, provider: modelProfile.provider, model: modelProfile.model } };
}

function requestLlmResponseBeforeCheckpoint(
  world: WorldReader,
  cmd: CommandSink,
  run: Entity,
  conversation: Entity,
  modelMessage: Entity,
  llmRequest: Entity,
  llmRequestId: string
): void {
  const runData = world.get(run, AgentRun);
  const conversationData = world.get(conversation, Conversation);
  if (!runData || !conversationData) return;
  const checkpointId = createMessageId();
  spawnCheckpointBarrier(cmd, {
    checkpointId,
    conversation,
    trigger: 'llm_response_before',
    targetKind: 'llm_request',
    targetRun: run,
    targetRunId: runData.id,
    targetMessage: modelMessage,
    targetMessageId: spawnedMessageId(modelMessage),
    targetLlmRequest: llmRequest,
    targetLlmRequestId: llmRequestId
  });
  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: { checkpointId, conversationId: conversationData.id, runId: runData.id, floorMessageId: spawnedMessageId(modelMessage), anchorPosition: 'before', trigger: 'llm_response_before' }
  });
}

function spawnedMessageId(entity: Entity): string {
  return `m${entity}`;
}

function spawnedInvocationId(entity: Entity): string {
  return `llmi${entity}`;
}

function spawnedInvocationRequestId(entity: Entity): string {
  return `req${entity}`;
}

function markRunRunning(world: WorldReader, cmd: CommandSink, run: Entity): void {
  const data = world.get(run, AgentRun);
  if (!data || (data.status !== 'queued' && data.status !== 'preparing')) return;
  cmd.add(run, AgentRun, { ...data, status: 'running', updatedAt: Date.now() });
}

function hasActiveRequest(world: WorldReader, run: Entity): boolean {
  return world.query(LlmRequest).some((request) => world.get(request, LlmRequest)?.run === run);
}

function hasActiveInvocation(world: WorldReader, run: Entity): boolean {
  return world
    .query(RunLlmInvocationLink)
    .map((entity) => world.get(entity, RunLlmInvocationLink))
    .some((link) => {
      if (!link || link.run !== run) return false;
      const invocation = world.get(link.invocation, LlmInvocation);
      return invocation?.status === 'resolving' || invocation?.status === 'ready' || invocation?.status === 'streaming';
    });
}

function drainQueuedInputsIntoRun(world: WorldReader, cmd: CommandSink, targetRun: Entity, conversation: Entity): void {
  const queuedRuns = world
    .query(AgentRun)
    .filter((run) => {
      if (run === targetRun) return false;
      const data = world.get(run, AgentRun);
      const target = targetForRun(world, run);
      return data?.status === 'queued'
        && target?.conversation === conversation
        && !hasQueueHold(world, run)
        && !world.has(run, AgentRunNeedsModel)
        && !hasActiveRequest(world, run);
    })
    .sort((left, right) => compareRunsByQueueOrder(world, left, right));

  if (queuedRuns.length === 0) return;
  const conversationData = world.get(conversation, Conversation);
  if (!conversationData) return;

  for (const queuedRun of queuedRuns) {
    const queuedInputEntity = queuedInputEntityForRun(world, queuedRun);
    if (queuedInputEntity === undefined) continue;
    const queuedInput = world.get(queuedInputEntity, AgentRunQueuedInput);
    if (!queuedInput) continue;
    const message = materializeUserInputMessage(world, cmd, conversation, conversationData.id, queuedInput.content);
    spawnMessageRunLink(cmd, { message, run: targetRun, role: 'input' });
    cmd.remove(queuedInputEntity, AgentRunQueuedInput);
    markQueuedRunMerged(world, cmd, queuedRun, targetRun);
  }
}

function markQueuedRunMerged(world: WorldReader, cmd: CommandSink, run: Entity, targetRun: Entity): void {
  const data = world.get(run, AgentRun);
  if (!data || data.status !== 'queued') return;
  const target = world.get(targetRun, AgentRun);
  const now = Date.now();
  cmd.add(run, AgentRun, {
    ...data,
    status: 'cancelled',
    updatedAt: now,
    completedAt: now,
    endReason: 'cancelled_by_policy',
    errorType: 'cancelled',
    error: `排队消息已合并到下一次 LLM 调用：${target?.id ?? targetRun}`
  });
  removeQueueArtifactsForRun(world, cmd, run);
}

function removeQueueArtifactsForRun(world: WorldReader, cmd: CommandSink, run: Entity): void {
  cmd.remove(run, AgentRunNeedsModel);
  const input = queuedInputEntityForRun(world, run);
  if (input !== undefined) cmd.remove(input, AgentRunQueuedInput);
  const order = queueOrderEntityForRun(world, run);
  if (order !== undefined) cmd.remove(order, AgentRunQueueOrder);
  const hold = queueHoldEntityForRun(world, run);
  if (hold !== undefined) cmd.remove(hold, AgentRunQueueHold);
}

function queuedInputEntityForRun(world: WorldReader, run: Entity): Entity | undefined {
  return world.query(AgentRunQueuedInput).find((entity) => world.get(entity, AgentRunQueuedInput)?.run === run);
}

function queueOrderEntityForRun(world: WorldReader, run: Entity): Entity | undefined {
  return world.query(AgentRunQueueOrder).find((entity) => world.get(entity, AgentRunQueueOrder)?.run === run);
}

function queueHoldEntityForRun(world: WorldReader, run: Entity): Entity | undefined {
  return world.query(AgentRunQueueHold).find((entity) => world.get(entity, AgentRunQueueHold)?.run === run);
}

function hasQueueHold(world: WorldReader, run: Entity): boolean {
  return queueHoldEntityForRun(world, run) !== undefined;
}

function compareRunsByQueueOrder(world: WorldReader, left: Entity, right: Entity): number {
  const leftKey = queueSortKey(world, left);
  const rightKey = queueSortKey(world, right);
  return leftKey.order - rightKey.order || leftKey.createdAt - rightKey.createdAt || left - right;
}

function queueSortKey(world: WorldReader, run: Entity): { order: number; createdAt: number } {
  const data = world.get(run, AgentRun);
  const orderEntity = queueOrderEntityForRun(world, run);
  const order = orderEntity !== undefined ? world.get(orderEntity, AgentRunQueueOrder)?.order : undefined;
  const createdAt = data?.createdAt ?? 0;
  return { order: order ?? createdAt, createdAt };
}

function targetForRun(world: WorldReader, run: Entity): { conversation: Entity } | undefined {
  const link = world
    .query(AgentRunTargetLink)
    .map((entity) => world.get(entity, AgentRunTargetLink))
    .find((candidate) => candidate?.run === run && world.has(candidate.conversation, Conversation));
  return link ? { conversation: link.conversation } : undefined;
}

function invocationEntityById(world: WorldReader, invocationId: string): Entity | undefined {
  return world.query(LlmInvocation).find((entity) => world.get(entity, LlmInvocation)?.id === invocationId);
}

function runForInvocation(world: WorldReader, invocation: Entity): Entity | undefined {
  return world
    .query(RunLlmInvocationLink)
    .map((entity) => world.get(entity, RunLlmInvocationLink))
    .find((link) => link?.invocation === invocation)?.run;
}

function messageForInvocation(world: WorldReader, invocation: Entity): Entity | undefined {
  return world
    .query(MessageLlmInvocationLink)
    .map((entity) => world.get(entity, MessageLlmInvocationLink))
    .find((link) => link?.invocation === invocation)?.message;
}
