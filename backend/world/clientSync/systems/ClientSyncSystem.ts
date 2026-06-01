import {
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationClientStateStreamId,
  conversationIdFromClientStateStreamId,
  type ClientPatchOp,
  type ClientState
} from '../../../../shared/protocol';
import { defineSystem, type AccessDeclaration } from '../../../ecs/types';
import { readEvents } from '../../events';
import type { ClientStateContributor } from '../contributors';
import { ClientSyncEventType } from '../events';
import { ClientStateContributorsKey, ClientSyncStateKey, type ClientStreamState } from '../resources';
import { emptyClientState, projectClientStateWithCache } from '../projection';

export const ClientSyncSystem = defineSystem({
  name: 'ClientSyncSystem',
  access(world) {
    const projectionReads = world.tryGetResource(ClientStateContributorsKey)?.reads() ?? emptyReads();
    return {
      reads: projectionReads,
      resources: {
        read: [ClientStateContributorsKey, ClientSyncStateKey],
        write: [ClientSyncStateKey],
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
    const contributors = registry.list();
    const projection = projectClientStateWithCache(world, contributors, syncState);
    const sourceChanged = syncState.lastState === null || projection.changed;
    const nextFull = projection.state;
    const prevFull = syncState.lastState;
    const resyncRequests = readEvents(ctx, ClientSyncEventType.Resync);
    const hasResyncRequests = resyncRequests.length > 0;
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

    if (!sourceChanged && !hasResyncRequests) return;

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

    for (const conversationId of collectConversationIds(prevFull, nextFull, streams, requestedConversationIds)) {
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
  }
});

function emptyReads(): AccessDeclaration {
  return { components: [], resources: [], events: [], effects: [] };
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

function diffClientState(contributors: ClientStateContributor[], prev: ClientState, next: ClientState): ClientPatchOp[] {
  return contributors.flatMap((contributor) => contributor.diff?.(prev, next) ?? []);
}

function globalClientState(state: ClientState): ClientState {
  return {
    ...emptyClientState(),
    agents: state.agents,
    agentModes: state.agentModes,
    toolPolicies: state.toolPolicies,
    approvalPolicies: state.approvalPolicies,
    systemPrompts: state.systemPrompts,
    modelProfiles: state.modelProfiles,
    agentModeLinks: state.agentModeLinks,
    modeToolPolicyLinks: state.modeToolPolicyLinks,
    modeApprovalPolicyLinks: state.modeApprovalPolicyLinks,
    modeSystemPromptLinks: state.modeSystemPromptLinks,
    modeModelProfileLinks: state.modeModelProfileLinks,
    conversations: state.conversations,
    conversationReuseLinks: state.conversationReuseLinks,
    conversationBranchLinks: state.conversationBranchLinks,
    agentConversationLinks: state.agentConversationLinks,
    agentRuns: state.agentRuns,
    agentRunSourceLinks: state.agentRunSourceLinks,
    agentRunTargetLinks: state.agentRunTargetLinks,
    messageRunLinks: state.messageRunLinks,
    toolCallRunLinks: state.toolCallRunLinks,
    runConversationPolicies: state.runConversationPolicies,
    runContextPolicies: state.runContextPolicies,
    runDeliveryPolicies: state.runDeliveryPolicies,
    runEditPolicies: state.runEditPolicies,
    runModeLinks: state.runModeLinks,
    runSystemPromptLinks: state.runSystemPromptLinks,
    runModelProfileLinks: state.runModelProfileLinks,
    runToolPolicyLinks: state.runToolPolicyLinks,
    runApprovalPolicyLinks: state.runApprovalPolicyLinks,
    runConversationPolicyLinks: state.runConversationPolicyLinks,
    runContextPolicyLinks: state.runContextPolicyLinks,
    runDeliveryPolicyLinks: state.runDeliveryPolicyLinks,
    runEditPolicyLinks: state.runEditPolicyLinks,
    agentRunInputRevisions: state.agentRunInputRevisions
  };
}

function conversationClientState(state: ClientState, conversationId: string): ClientState {
  const messages = state.messages.filter((message) => message.conversationId === conversationId);
  const messageIds = new Set(messages.map((message) => message.id));
  const toolCalls = state.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
  const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
  const runIds = collectConversationRunIds(state, conversationId, messageIds, toolCallIds);
  const runPolicyIds = collectRunPolicyIds(state, runIds);

  return {
    ...emptyClientState(),
    conversations: state.conversations.filter((conversation) => conversation.id === conversationId || conversationReferencedByRuns(state, conversation.id, runIds)),
    conversationReuseLinks: state.conversationReuseLinks.filter((link) => link.conversationId === conversationId),
    conversationBranchLinks: state.conversationBranchLinks.filter((link) => link.sourceConversationId === conversationId || link.targetConversationId === conversationId),
    messages,
    messageRevisions: state.messageRevisions.filter((revision) => revision.conversationId === conversationId),
    messageCurrentRevisionLinks: state.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId)),
    toolCalls,
    toolCallEvents: state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId)),
    agentRuns: state.agentRuns.filter((run) => runIds.has(run.id)),
    agentRunSourceLinks: state.agentRunSourceLinks.filter((link) => runIds.has(link.runId) || (link.sourceRunId !== undefined && runIds.has(link.sourceRunId))),
    agentRunTargetLinks: state.agentRunTargetLinks.filter((link) => runIds.has(link.runId)),
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
    runApprovalPolicyLinks: state.runApprovalPolicyLinks.filter((link) => runIds.has(link.runId)),
    runConversationPolicyLinks: state.runConversationPolicyLinks.filter((link) => runIds.has(link.runId)),
    runContextPolicyLinks: state.runContextPolicyLinks.filter((link) => runIds.has(link.runId)),
    runDeliveryPolicyLinks: state.runDeliveryPolicyLinks.filter((link) => runIds.has(link.runId)),
    runEditPolicyLinks: state.runEditPolicyLinks.filter((link) => runIds.has(link.runId)),
    agentRunInputRevisions: state.agentRunInputRevisions.filter((inputRevision) => runIds.has(inputRevision.runId))
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
  requested: ReadonlySet<string>
): string[] {
  const ids = new Set<string>(requested);
  for (const conversation of prev?.conversations ?? []) ids.add(conversation.id);
  for (const conversation of next.conversations) ids.add(conversation.id);
  for (const message of prev?.messages ?? []) ids.add(message.conversationId);
  for (const message of next.messages) ids.add(message.conversationId);
  for (const streamId of Object.keys(streams)) {
    const conversationId = conversationIdFromClientStateStreamId(streamId);
    if (conversationId) ids.add(conversationId);
  }
  return [...ids];
}
