import {
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationClientStateStreamId,
  conversationIdFromClientStateStreamId,
  type ClientState
} from '../../../../shared/protocol';
import { defineSystem, type AccessDeclaration, type WorldReader } from '../../../ecs/types';
import { readEvents } from '../../events';
import type { ClientStateContributor } from '../contributors';
import { ClientSyncEventType } from '../events';
import { ClientStateContributorsKey, ClientSyncStateKey, type ClientStreamState } from '../resources';

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
    const nextFull = projectClientState(world, contributors);
    const prevFull = syncState.lastState;
    const resyncRequests = readEvents(ctx, ClientSyncEventType.Resync);
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

    const streams: Record<string, ClientStreamState> = { ...syncState.streams };
    let didUpdateStreams = false;
    const fullChanged = prevFull === null || !sameClientState(prevFull, nextFull);

    if (wantsGlobalSnapshot || (fullChanged && streams[GLOBAL_CLIENT_STATE_STREAM_ID])) {
      const next = globalClientState(nextFull);
      const stream = nextStreamSnapshot(streams[GLOBAL_CLIENT_STATE_STREAM_ID], next);
      streams[GLOBAL_CLIENT_STATE_STREAM_ID] = stream;
      didUpdateStreams = true;
      cmd.effect({ kind: 'client.snapshot', streamId: GLOBAL_CLIENT_STATE_STREAM_ID, streamSeq: stream.streamSeq, state: next });
    }

    for (const conversationId of collectConversationIds(prevFull, nextFull, streams, requestedConversationIds)) {
      const streamId = conversationClientStateStreamId(conversationId);
      const existing = streams[streamId];
      const requested = requestedConversationIds.has(conversationId);
      if (!requested && !existing) continue;
      const next = conversationClientState(nextFull, conversationId);
      if (!requested && existing?.lastState && sameClientState(existing.lastState, next)) continue;
      const updated = nextStreamSnapshot(existing, next);
      streams[streamId] = updated;
      didUpdateStreams = true;
      cmd.effect({ kind: 'client.snapshot', streamId, streamSeq: updated.streamSeq, state: next });
    }

    if (fullChanged || didUpdateStreams) {
      cmd.setResource(ClientSyncStateKey, { lastState: nextFull, streams });
    }
  }
});

function emptyReads(): AccessDeclaration {
  return { components: [], resources: [], events: [], effects: [] };
}

function projectClientState(world: WorldReader, contributors: ClientStateContributor[]): ClientState {
  const state: ClientState = emptyClientState();
  for (const contributor of contributors) {
    if (!contributor.project) throw new Error(`ClientState contributor "${contributor.key}" does not provide a main-thread projector.`);
    Object.assign(state, contributor.project(world));
  }
  return state;
}

function emptyClientState(): ClientState {
  return {
    agents: [],
    agentModes: [],
    toolPolicies: [],
    approvalPolicies: [],
    systemPrompts: [],
    modelProfiles: [],
    agentModeLinks: [],
    modeToolPolicyLinks: [],
    modeApprovalPolicyLinks: [],
    modeSystemPromptLinks: [],
    modeModelProfileLinks: [],
    conversations: [],
    conversationReuseLinks: [],
    conversationBranchLinks: [],

    agentConversationLinks: [],
    messages: [],
    messageRevisions: [],
    messageCurrentRevisionLinks: [],
    toolCalls: [],
    toolCallEvents: [],
    agentRuns: [],
    agentRunSourceLinks: [],
    agentRunTargetLinks: [],
    messageRunLinks: [],
    toolCallRunLinks: [],
    runConversationPolicies: [],
    runContextPolicies: [],
    runDeliveryPolicies: [],
    runEditPolicies: [],
    runModeLinks: [],
    runSystemPromptLinks: [],
    runModelProfileLinks: [],
    runToolPolicyLinks: [],
    runApprovalPolicyLinks: [],
    runConversationPolicyLinks: [],
    runContextPolicyLinks: [],
    runDeliveryPolicyLinks: [],
    runEditPolicyLinks: [],
    agentRunInputRevisions: []
  };
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
  return {
    ...emptyClientState(),
    conversations: state.conversations.filter((conversation) => conversation.id === conversationId),
    conversationReuseLinks: state.conversationReuseLinks.filter((link) => link.conversationId === conversationId),
    conversationBranchLinks: state.conversationBranchLinks.filter((link) => link.sourceConversationId === conversationId || link.targetConversationId === conversationId),
    messages,
    messageRevisions: state.messageRevisions.filter((revision) => revision.conversationId === conversationId),
    messageCurrentRevisionLinks: state.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId)),
    toolCalls,
    toolCallEvents: state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId))
  };
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

function sameClientState(left: ClientState | null, right: ClientState | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
