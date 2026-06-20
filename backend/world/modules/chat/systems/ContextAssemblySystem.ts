import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import type { LlmModelSettings } from '../../llm/contracts';
import { LlmEventType, type LlmInvocationResolvedPayload, type LlmInvocationResolveErrorPayload } from '../../llm/events';
import { AgentRun, AgentRunNeedsModel, AgentRunTargetLink, MessageRunLink, RunModeLink, RunModelProfileLink } from '../../agentRun/components';
import { spawnMessageRunLink } from '../../agentRun/bundles';
import { activeModelProfileForRun } from '../../agentRun/queries';
import { ConversationModeSelection, Mode, ModelProfile, ModelProfileScopeLink } from '../../mode/components';
import { LlmRequest, Conversation, Message } from '../components';
import { ModelMessageBundle, LlmRequestBundle, MessageBundle, spawnMessage, spawnModelMessage, spawnLlmRequest } from '../bundles';
import { CheckpointEventType } from '../../checkpoint/events';
import { LlmInvocation, MessageLlmInvocationLink, RunLlmInvocationLink } from '../../llm/components';
import { LlmInvocationBundle, MessageLlmInvocationLinkBundle, spawnLlmInvocation, spawnMessageLlmInvocationLink, spawnRunLlmInvocationLink } from '../../llm/bundles';

const RunsNeedingModelQuery = defineQuery({
  name: 'RunsNeedingModel',
  all: [AgentRun, AgentRunNeedsModel],
  read: [AgentRun, AgentRunNeedsModel, AgentRunTargetLink, LlmRequest, Conversation],
  remove: [AgentRunNeedsModel],
  mutationMode: 'consume',
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
    reads: { components: [RunModeLink, RunModelProfileLink, ConversationModeSelection, Mode, ModelProfile, ModelProfileScopeLink] },
    bundles: [ModelMessageBundle, MessageBundle, LlmRequestBundle, LlmInvocationBundle, MessageLlmInvocationLinkBundle],
    writes: { components: [AgentRun, MessageRunLink] },
    events: { read: [LlmEventType.InvocationResolved, LlmEventType.InvocationResolveError], emit: [CheckpointEventType.Requested] },
    effects: { emit: ['llm.resolveInvocation'] }
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

function materializeResolvedInvocation(world: WorldReader, cmd: CommandSink, payload: LlmInvocationResolvedPayload): void {
  const invocation = invocationEntityById(world, payload.invocationId);
  if (invocation === undefined) return;
  const current = world.get(invocation, LlmInvocation);
  if (!current) return;

  const run = runForInvocation(world, invocation);
  if (run === undefined) return;
  const target = targetForRun(world, run);
  if (!target) return;

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
  spawnLlmRequest(cmd, { run, conversation: target.conversation, modelMessage, invocation, requestId: payload.requestId });
  requestLlmResponseBeforeCheckpoint(world, cmd, run, target.conversation, modelMessage);
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

function requestLlmResponseBeforeCheckpoint(world: WorldReader, cmd: CommandSink, run: Entity, conversation: Entity, modelMessage: Entity): void {
  const runData = world.get(run, AgentRun);
  const conversationData = world.get(conversation, Conversation);
  if (!runData || !conversationData) return;
  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: { conversationId: conversationData.id, runId: runData.id, floorMessageId: spawnedMessageId(modelMessage), anchorPosition: 'before', trigger: 'llm_response_before' }
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
