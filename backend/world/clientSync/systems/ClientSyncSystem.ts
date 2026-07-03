import {
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationClientStateStreamId,
  conversationIdFromClientStateStreamId,
  isTextPart,
  type ClientPatchOp,
  type ClientState,
  type ClientStateTableKey,
  type MessageRecord
} from '../../../../shared/protocol';
import { clientStateWithTables, createEmptyClientState, GLOBAL_CLIENT_STATE_TABLE_KEYS } from '../../../../shared/clientStateSchema';
import { collectChangedClientStateConversationIds } from '../../../../shared/clientStateConversationScope';
import { defineSystem, type AccessDeclaration, type WorldReader } from '../../../ecs/types';
import { readEvents } from '../../events';
import { LlmRequest } from '../../modules/chat/components';
import type { ClientStateContributor } from '../contributors';
import { diffClientStateTables } from '../diff';
import { ClientSyncEventType } from '../events';
import { ClientStateContributorsKey, ClientSyncFastPatchStateKey, ClientSyncStateKey, type ClientStreamState, type ClientSyncFastPatchState, type ClientSyncState } from '../resources';
import { projectClientStateWithCache } from '../projection';
import { contributorClock } from '../../projection/cache';

export const ClientSyncSystem = defineSystem({
  name: 'ClientSyncSystem',
  access(world) {
    const projectionReads = world.tryGetResource(ClientStateContributorsKey)?.reads() ?? emptyReads();
    return {
      reads: {
        ...projectionReads,
        components: [...(projectionReads.components ?? []), LlmRequest]
      },
      resources: {
        read: [ClientStateContributorsKey, ClientSyncStateKey, ClientSyncFastPatchStateKey],
        write: [ClientSyncStateKey, ClientSyncFastPatchStateKey],
        mutationMode: 'update'
      },
      events: { read: [ClientSyncEventType.Resync] },
      effects: { emit: ['client.snapshot', 'client.patch'] }
    };
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const registry = world.getResource(ClientStateContributorsKey);
    const syncState = world.getResource(ClientSyncStateKey);
    const fastPatchState = world.getResource(ClientSyncFastPatchStateKey);
    const contributors = registry.list();
    const resyncRequests = readEvents(ctx, ClientSyncEventType.Resync);
    const hasResyncRequests = resyncRequests.length > 0;
    const hasActiveLlmRequests = world.query(LlmRequest).length > 0;
    const shouldDeferFullSync = fastPatchState.deferFullSync && hasActiveLlmRequests;
    const canUseFastPath = fastPatchState.patches.length > 0
      && shouldDeferFullSync
      && !fastPatchState.requireFullSync
      && syncState.lastState !== null
      && !hasResyncRequests;
    if (canUseFastPath) {
      if (emitFastPatches(cmd, syncState, fastPatchState)) return;
    }

    if (shouldDeferFullSync && !fastPatchState.requireFullSync && !hasResyncRequests && fastPatchState.patches.length === 0 && canDeferFullSyncForActiveStream(world, contributors, syncState)) return;

    const projection = projectClientStateWithCache(world, contributors, syncState);
    const sourceChanged = syncState.lastState === null || projection.changed || fastPatchState.requireFullSync;
    const changedTableKeys = sourceChanged ? changedClientStateTableKeys(contributors, projection.changedContributorKeys) : [];
    const nextFull = projection.state;
    const prevFull = syncState.lastState;
    const requestedConversationIds = new Set<string>();
    let wantsGlobalSnapshot = prevFull === null;

    for (const request of resyncRequests) {
      const streamId = request.streamId;
      const conversationId = request.conversationId ?? (streamId ? conversationIdFromClientStateStreamId(streamId) : undefined);
      if (conversationId) {
        requestedConversationIds.add(conversationId);
        continue;
      }
      if (!streamId || streamId === GLOBAL_CLIENT_STATE_STREAM_ID) wantsGlobalSnapshot = true;
    }

    if (!sourceChanged && !hasResyncRequests) {
      clearFastPatchStateIfNeeded(cmd, fastPatchState);
      return;
    }

    const streams: Record<string, ClientStreamState> = { ...syncState.streams };
    let didUpdateStreams = false;

    const globalNext = globalClientState(nextFull);
    const globalExisting = streams[GLOBAL_CLIENT_STATE_STREAM_ID];
    if (wantsGlobalSnapshot) {
      streams[GLOBAL_CLIENT_STATE_STREAM_ID] = emitSnapshot(cmd, GLOBAL_CLIENT_STATE_STREAM_ID, globalExisting, globalNext);
      didUpdateStreams = true;
    } else if (globalExisting) {
      const updated = emitPatchIfChanged(cmd, contributors, GLOBAL_CLIENT_STATE_STREAM_ID, globalExisting, globalNext);
      if (updated) {
        streams[GLOBAL_CLIENT_STATE_STREAM_ID] = updated;
        didUpdateStreams = true;
      }
    }

    for (const conversationId of collectConversationIds(prevFull, nextFull, streams, requestedConversationIds, sourceChanged, changedTableKeys)) {
      const streamId = conversationClientStateStreamId(conversationId);
      const existing = streams[streamId];
      const requested = requestedConversationIds.has(conversationId);
      if (!requested && !existing) continue;
      const next = conversationClientState(nextFull, conversationId);
      if (requested || !existing?.lastState) {
        streams[streamId] = emitSnapshot(cmd, streamId, existing, next);
        didUpdateStreams = true;
        continue;
      }
      const updated = emitPatchIfChanged(cmd, contributors, streamId, existing, next);
      if (updated) {
        streams[streamId] = updated;
        didUpdateStreams = true;
      }
    }

    if (sourceChanged || didUpdateStreams) {
      cmd.setResource(ClientSyncStateKey, {
        lastState: nextFull,
        projectionClock: projection.projectionClock,
        contributorStates: projection.contributorStates,
        streams
      });
    }
    clearFastPatchStateIfNeeded(cmd, fastPatchState);
  }
});

const DEFERRABLE_ACTIVE_STREAM_CONTRIBUTORS = new Set(['chat']);

function emptyReads(): AccessDeclaration {
  return { components: [], resources: [], events: [], effects: [] };
}

function canDeferFullSyncForActiveStream(world: WorldReader, contributors: readonly ClientStateContributor[], syncState: ClientSyncState): boolean {
  if (!syncState.lastState) return false;
  return contributors.every((contributor) => {
    const previousClock = syncState.contributorStates[contributor.key]?.clock;
    const nextClock = contributorClock(world, contributor);
    return previousClock === nextClock || DEFERRABLE_ACTIVE_STREAM_CONTRIBUTORS.has(contributor.key);
  });
}

function emitSnapshot(cmd: { effect(effect: unknown): void }, streamId: string, current: ClientStreamState | undefined, state: ClientState): ClientStreamState {
  const stream = nextStreamSnapshot(current, state);
  cmd.effect({ kind: 'client.snapshot', streamId, streamSeq: stream.streamSeq, state });
  return stream;
}

function emitPatchIfChanged(
  cmd: { effect(effect: unknown): void },
  contributors: ClientStateContributor[],
  streamId: string,
  current: ClientStreamState,
  next: ClientState
): ClientStreamState | undefined {
  if (!current.lastState) return emitSnapshot(cmd, streamId, current, next);
  const patches = diffClientState(contributors, current.lastState, next);
  if (patches.length === 0) return undefined;
  const stream: ClientStreamState = { streamSeq: current.streamSeq + 1, lastState: next };
  cmd.effect({ kind: 'client.patch', streamId, streamSeq: stream.streamSeq, patches });
  return stream;
}

function emitFastPatches(
  cmd: { effect(effect: unknown): void; setResource<T>(key: { readonly id: symbol; readonly name: string; readonly __t?: T }, value: T): void },
  syncState: { lastState: ClientState | null; projectionClock: string; contributorStates: Record<string, unknown>; streams: Record<string, ClientStreamState> },
  fastPatchState: ClientSyncFastPatchState
): boolean {
  if (!syncState.lastState) return false;
  const batches = mergeFastPatchBatches(fastPatchState.patches);
  const allPatches = batches.flatMap((batch) => batch.patches);
  const nextFull = applyMessageFastPatches(syncState.lastState, allPatches);
  if (!nextFull) return false;

  const streams: Record<string, ClientStreamState> = { ...syncState.streams };
  const emitted: Array<{ streamId: string; streamSeq: number; patches: readonly ClientPatchOp[] }> = [];

  for (const batch of batches) {
    const existing = streams[batch.streamId];
    if (!existing) continue;
    if (!existing.lastState) return false;
    const nextStreamState = applyMessageFastPatches(existing.lastState, batch.patches);
    if (!nextStreamState) return false;
    const stream: ClientStreamState = { streamSeq: existing.streamSeq + 1, lastState: nextStreamState };
    streams[batch.streamId] = stream;
    emitted.push({ streamId: batch.streamId, streamSeq: stream.streamSeq, patches: batch.patches });
  }

  cmd.setResource(ClientSyncStateKey, {
    lastState: nextFull,
    projectionClock: syncState.projectionClock,
    contributorStates: syncState.contributorStates as never,
    streams
  });
  cmd.setResource(ClientSyncFastPatchStateKey, {
    patches: [],
    deferFullSync: fastPatchState.deferFullSync,
    requireFullSync: false
  });

  for (const item of emitted) {
    cmd.effect({ kind: 'client.patch', streamId: item.streamId, streamSeq: item.streamSeq, patches: item.patches });
  }
  return true;
}

function mergeFastPatchBatches(batches: ClientSyncFastPatchState['patches']): Array<{ streamId: string; patches: readonly ClientPatchOp[] }> {
  const byStreamId = new Map<string, ClientPatchOp[]>();
  for (const batch of batches) {
    const patches = byStreamId.get(batch.streamId) ?? [];
    patches.push(...batch.patches);
    byStreamId.set(batch.streamId, patches);
  }
  return [...byStreamId.entries()].map(([streamId, patches]) => ({ streamId, patches }));
}

function applyMessageFastPatches(state: ClientState, patches: readonly ClientPatchOp[]): ClientState | undefined {
  let nextMessages: MessageRecord[] | undefined;
  const indexById = new Map(state.messages.map((message, index) => [message.id, index]));

  for (const patch of patches) {
    if (!isMessageFastPatch(patch)) return undefined;
    const index = indexById.get(patch.id);
    if (index === undefined) return undefined;
    const messages = nextMessages ?? state.messages;
    const message = messages[index];
    if (!message) return undefined;
    const nextMessage = applyMessageFastPatch(message, patch);
    if (!nextMessage) return undefined;
    nextMessages ??= [...state.messages];
    nextMessages[index] = nextMessage;
  }

  return nextMessages ? { ...state, messages: nextMessages } : state;
}

type MessageFastPatch = Extract<ClientPatchOp, { kind: 'message.partText.append' | 'message.partThoughtElapsed.set' | 'message.part.insert' }>;

function isMessageFastPatch(patch: ClientPatchOp): patch is MessageFastPatch {
  return patch.kind === 'message.partText.append' || patch.kind === 'message.partThoughtElapsed.set' || patch.kind === 'message.part.insert';
}

function applyMessageFastPatch(message: MessageRecord, patch: MessageFastPatch): MessageRecord | undefined {
  const parts = message.content.parts;
  if (patch.kind === 'message.partText.append') {
    const part = parts[patch.partIndex];
    if (!part || !isTextPart(part)) return undefined;
    const nextParts = [...parts];
    nextParts[patch.partIndex] = { ...part, text: part.text + patch.delta };
    return { ...message, content: { ...message.content, parts: nextParts } };
  }

  if (patch.kind === 'message.partThoughtElapsed.set') {
    const part = parts[patch.partIndex];
    if (!part || !isTextPart(part)) return undefined;
    const nextParts = [...parts];
    nextParts[patch.partIndex] = { ...part, thoughtElapsedMs: patch.elapsedMs };
    return { ...message, content: { ...message.content, parts: nextParts } };
  }

  if (patch.index < 0 || patch.index > parts.length) return undefined;
  const nextParts = [...parts];
  nextParts.splice(patch.index, 0, clonePatchValue(patch.part));
  return { ...message, content: { ...message.content, parts: nextParts } };
}

function clonePatchValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function clearFastPatchStateIfNeeded(cmd: { setResource<T>(key: { readonly id: symbol; readonly name: string; readonly __t?: T }, value: T): void }, state: ClientSyncFastPatchState): void {
  if (state.patches.length === 0 && !state.deferFullSync && !state.requireFullSync) return;
  cmd.setResource(ClientSyncFastPatchStateKey, { patches: [], deferFullSync: false, requireFullSync: false });
}

function diffClientState(contributors: ClientStateContributor[], prev: ClientState, next: ClientState): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  for (const contributor of contributors) {
    patches.push(...diffClientStateTables(prev, next, contributor.tables ?? []));
    patches.push(...(contributor.diff?.(prev, next) ?? []));
  }
  return patches;
}

function globalClientState(state: ClientState): ClientState {
  return clientStateWithTables(state, GLOBAL_CLIENT_STATE_TABLE_KEYS);
}

function conversationClientState(state: ClientState, conversationId: string): ClientState {
  const messages = state.messages.filter((message) => message.conversationId === conversationId);
  const messageIds = new Set(messages.map((message) => message.id));
  const toolCalls = state.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
  const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
  const runIds = collectConversationRunIds(state, conversationId, messageIds, toolCallIds);
  const runPolicyIds = collectRunPolicyIds(state, runIds);
  const conversationProjectLinks = state.conversationProjectLinks.filter((link) => link.conversationId === conversationId);
  const projectContextIds = new Set(conversationProjectLinks.map((link) => link.projectContextId));
  const conversationModeSelections = state.conversationModeSelections.filter((selection) => selection.conversationId === conversationId);
  const checkpointTimelineAnchors = state.checkpointTimelineAnchors.filter((anchor) => anchor.conversationId === conversationId);
  const checkpointIds = new Set(checkpointTimelineAnchors.map((anchor) => anchor.checkpointId));
  const checkpoints = state.checkpoints.filter((checkpoint) => checkpoint.conversationId === conversationId || checkpointIds.has(checkpoint.id));
  for (const checkpoint of checkpoints) {
    checkpointIds.add(checkpoint.id);
    projectContextIds.add(checkpoint.projectContextId);
  }
  const shadowRepositoryIds = new Set(checkpoints.map((checkpoint) => checkpoint.shadowRepositoryId));
  const conversationCheckpointRepositoryLinks = state.conversationCheckpointRepositoryLinks.filter((link) => {
    const matches = link.conversationId === conversationId || shadowRepositoryIds.has(link.shadowRepositoryId) || projectContextIds.has(link.projectContextId);
    if (matches) {
      shadowRepositoryIds.add(link.shadowRepositoryId);
      projectContextIds.add(link.projectContextId);
    }
    return matches;
  });
  const compressionBlocks = state.compressionBlocks.filter((block) => block.conversationId === conversationId);
  const compressionBlockIds = new Set(compressionBlocks.map((block) => block.id));
  const compressionVariantIds = new Set(state.runCompressionBlockLinks.filter((link) => compressionBlockIds.has(link.blockId)).map((link) => link.variantId).filter((id): id is string => !!id));
  const compressionBlockLlmInvocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => compressionBlockIds.has(link.blockId));
  const invocationIds = new Set(compressionBlockLlmInvocationLinks.map((link) => link.invocationId));
  for (const link of state.runLlmInvocationLinks.filter((link) => runIds.has(link.runId))) invocationIds.add(link.invocationId);
  for (const link of state.messageLlmInvocationLinks.filter((link) => messageIds.has(link.messageId))) invocationIds.add(link.invocationId);
  const conversationRuntimeContextSnapshotLinks = state.conversationRuntimeContextSnapshotLinks.filter((link) => link.conversationId === conversationId);
  const runRuntimeContextSnapshotLinks = state.runRuntimeContextSnapshotLinks.filter((link) => runIds.has(link.runId));
  const conversationWorkEnvironmentLinks = state.conversationWorkEnvironmentLinks.filter((link) => link.conversationId === conversationId);
  const runWorkEnvironmentLinks = state.runWorkEnvironmentLinks.filter((link) => runIds.has(link.runId));
  const runtimeContextSnapshotIds = new Set<string>();
  for (const link of conversationRuntimeContextSnapshotLinks) runtimeContextSnapshotIds.add(link.runtimeContextSnapshotId);
  for (const link of runRuntimeContextSnapshotLinks) runtimeContextSnapshotIds.add(link.runtimeContextSnapshotId);

  return {
    ...createEmptyClientState(),
    conversations: state.conversations.filter((conversation) => conversation.id === conversationId || conversationReferencedByRuns(state, conversation.id, runIds)),
    conversationReuseLinks: state.conversationReuseLinks.filter((link) => link.conversationId === conversationId),
    conversationBranchLinks: state.conversationBranchLinks.filter((link) => link.sourceConversationId === conversationId || link.targetConversationId === conversationId),
    conversationOriginLinks: state.conversationOriginLinks.filter((link) => link.conversationId === conversationId),
    projectContexts: state.projectContexts.filter((projectContext) => projectContextIds.has(projectContext.id)),
    conversationProjectLinks,
    shadowRepositories: state.shadowRepositories.filter((repository) => shadowRepositoryIds.has(repository.id)),
    conversationCheckpointRepositoryLinks,
    checkpoints,
    checkpointTimelineAnchors,
    conversationModeSelections,
    messages,
    messageRevisions: state.messageRevisions.filter((revision) => revision.conversationId === conversationId),
    messageCurrentRevisionLinks: state.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId)),
    compressionBlocks,
    compressionBlockSourceLinks: state.compressionBlockSourceLinks.filter((link) => compressionBlockIds.has(link.blockId)),
    compressionContextVariants: state.compressionContextVariants.filter((variant) => compressionBlockIds.has(variant.blockId) || compressionVariantIds.has(variant.id)),
    runCompressionBlockLinks: state.runCompressionBlockLinks.filter((link) => runIds.has(link.runId) || compressionBlockIds.has(link.blockId)),
    compressionBlockLlmInvocationLinks,
    llmInvocations: state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id)),
    runLlmInvocationLinks: state.runLlmInvocationLinks.filter((link) => runIds.has(link.runId) || invocationIds.has(link.invocationId)),
    messageLlmInvocationLinks: state.messageLlmInvocationLinks.filter((link) => messageIds.has(link.messageId) || invocationIds.has(link.invocationId)),
    toolCalls,
    toolCallEvents: state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId)),
    agentRuns: state.agentRuns.filter((run) => runIds.has(run.id)),
    agentRunSourceLinks: state.agentRunSourceLinks.filter((link) => runIds.has(link.runId) || (link.sourceRunId !== undefined && runIds.has(link.sourceRunId))),
    agentRunTargetLinks: state.agentRunTargetLinks.filter((link) => runIds.has(link.runId)),
    agentRunQueueOrders: state.agentRunQueueOrders.filter((order) => runIds.has(order.runId)),
    agentRunQueueHolds: state.agentRunQueueHolds.filter((hold) => runIds.has(hold.runId)),
    agentRunQueuedInputs: state.agentRunQueuedInputs.filter((input) => runIds.has(input.runId)),
    messageRunLinks: state.messageRunLinks.filter((link) => runIds.has(link.runId) || messageIds.has(link.messageId)),
    toolCallRunLinks: state.toolCallRunLinks.filter((link) => runIds.has(link.runId) || toolCallIds.has(link.toolCallId)),
    runConversationPolicies: state.runConversationPolicies.filter((policy) => runPolicyIds.conversationPolicyIds.has(policy.id)),
    runContextPolicies: state.runContextPolicies.filter((policy) => runPolicyIds.contextPolicyIds.has(policy.id)),
    runDeliveryPolicies: state.runDeliveryPolicies.filter((policy) => runPolicyIds.deliveryPolicyIds.has(policy.id)),
    runEditPolicies: state.runEditPolicies.filter((policy) => runPolicyIds.editPolicyIds.has(policy.id)),
    runModeLinks: state.runModeLinks.filter((link) => runIds.has(link.runId)),
    runSystemPromptLinks: state.runSystemPromptLinks.filter((link) => runIds.has(link.runId)),
    runModelProfileLinks: state.runModelProfileLinks.filter((link) => runIds.has(link.runId)),
    runToolPolicyLinks: state.runToolPolicyLinks.filter((link) => runIds.has(link.runId)),
    runConversationPolicyLinks: state.runConversationPolicyLinks.filter((link) => runIds.has(link.runId)),
    runContextPolicyLinks: state.runContextPolicyLinks.filter((link) => runIds.has(link.runId)),
    runDeliveryPolicyLinks: state.runDeliveryPolicyLinks.filter((link) => runIds.has(link.runId)),
    runEditPolicyLinks: state.runEditPolicyLinks.filter((link) => runIds.has(link.runId)),
    agentRunInputRevisions: state.agentRunInputRevisions.filter((inputRevision) => runIds.has(inputRevision.runId)),
    runtimeContextSnapshots: state.runtimeContextSnapshots.filter((snapshot) => snapshot.conversationId === conversationId || runtimeContextSnapshotIds.has(snapshot.id)),
    conversationRuntimeContextSnapshotLinks,
    runRuntimeContextSnapshotLinks,
    conversationWorkEnvironmentLinks,
    runWorkEnvironmentLinks
  };
}

function collectConversationRunIds(state: ClientState, conversationId: string, messageIds: ReadonlySet<string>, toolCallIds: ReadonlySet<string>): Set<string> {
  const runIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const add = (id: string | undefined): void => {
      if (!id || runIds.has(id)) return;
      runIds.add(id);
      changed = true;
    };
    for (const link of state.agentRunTargetLinks) if (link.conversationId === conversationId || runIds.has(link.runId)) add(link.runId);
    for (const link of state.agentRunSourceLinks) {
      if (link.sourceConversationId === conversationId || (link.sourceMessageId && messageIds.has(link.sourceMessageId)) || (link.sourceToolCallId && toolCallIds.has(link.sourceToolCallId)) || (link.sourceRunId && runIds.has(link.sourceRunId)) || runIds.has(link.runId)) {
        add(link.runId);
      }
    }
    for (const link of state.messageRunLinks) if (messageIds.has(link.messageId) || runIds.has(link.runId)) add(link.runId);
    for (const link of state.toolCallRunLinks) if (toolCallIds.has(link.toolCallId) || runIds.has(link.runId)) add(link.runId);
  }
  return runIds;
}

function collectRunPolicyIds(state: ClientState, runIds: ReadonlySet<string>): {
  conversationPolicyIds: Set<string>;
  contextPolicyIds: Set<string>;
  deliveryPolicyIds: Set<string>;
  editPolicyIds: Set<string>;
} {
  return {
    conversationPolicyIds: new Set(state.runConversationPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId)),
    contextPolicyIds: new Set(state.runContextPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId)),
    deliveryPolicyIds: new Set(state.runDeliveryPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId)),
    editPolicyIds: new Set(state.runEditPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId))
  };
}

function conversationReferencedByRuns(state: ClientState, conversationId: string, runIds: ReadonlySet<string>): boolean {
  return state.agentRunTargetLinks.some((link) => runIds.has(link.runId) && link.conversationId === conversationId)
    || state.agentRunSourceLinks.some((link) => runIds.has(link.runId) && link.sourceConversationId === conversationId);
}

function nextStreamSnapshot(current: ClientStreamState | undefined, state: ClientState): ClientStreamState {
  return { streamSeq: (current?.streamSeq ?? 0) + 1, lastState: state };
}

function collectConversationIds(
  prev: ClientState | null,
  next: ClientState,
  streams: Record<string, ClientStreamState>,
  requested: ReadonlySet<string>,
  sourceChanged: boolean,
  changedTableKeys: readonly ClientStateTableKey[] | undefined
): string[] {
  const ids = new Set<string>(requested);
  if (prev === null) {
    for (const conversation of next.conversations) ids.add(conversation.id);
    for (const streamId of Object.keys(streams)) {
      const conversationId = conversationIdFromClientStateStreamId(streamId);
      if (conversationId) ids.add(conversationId);
    }
    return [...ids];
  }

  if (sourceChanged) {
    for (const conversationId of collectChangedClientStateConversationIds(prev, next, changedTableKeys)) ids.add(conversationId);
  }

  const subscribedConversationIds = new Set<string>();
  for (const streamId of Object.keys(streams)) {
    const conversationId = conversationIdFromClientStateStreamId(streamId);
    if (conversationId) subscribedConversationIds.add(conversationId);
  }
  return [...ids].filter((conversationId) => requested.has(conversationId) || subscribedConversationIds.has(conversationId));
}

function changedClientStateTableKeys(contributors: readonly ClientStateContributor[], changedContributorKeys: readonly string[]): readonly ClientStateTableKey[] | undefined {
  if (changedContributorKeys.length === 0) return undefined;
  const byKey = new Map(contributors.map((contributor) => [contributor.key, contributor]));
  const tableKeys = new Set<ClientStateTableKey>();
  for (const key of changedContributorKeys) {
    const tables = byKey.get(key)?.tables;
    if (!tables || tables.length === 0) return undefined;
    for (const tableKey of tables) tableKeys.add(tableKey);
  }
  return [...tableKeys];
}
