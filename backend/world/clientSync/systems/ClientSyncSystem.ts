import {
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationClientStateStreamId,
  conversationIdFromClientStateStreamId,
  type AgentConversationLinkRecord,
  type AgentModeLinkRecord,
  type AgentModeRecord,
  type AgentRecord,
  type ClientPatchOp,
  type ClientState,
  type MessageRecord,
  type ModeModelProfileLinkRecord,
  type ModeSystemPromptLinkRecord,
  type ModeToolPolicyLinkRecord,
  type ModelProfileRecord,
  type SessionRecord,
  type SystemPromptRecord,
  type ToolCallEventRecord,
  type ToolCallRecord,
  type ToolPolicyRecord,
  isTextPart,
  isVisibleTextPart,
  type TextPart
} from '../../../../shared/protocol';
import { defineSystem, type AccessDeclaration, type WorldReader } from '../../../ecs/types';
import { readEvents } from '../../events';
import { diffUpsertRemove } from '../diff';
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
      const conversationId = request.sessionId ?? (streamId ? conversationIdFromClientStateStreamId(streamId) : undefined);
      if (conversationId) {
        requestedConversationIds.add(conversationId);
        continue;
      }
      if (!streamId || streamId === GLOBAL_CLIENT_STATE_STREAM_ID) {
        wantsGlobalSnapshot = true;
      }
    }

    const streams: Record<string, ClientStreamState> = { ...syncState.streams };
    let didUpdateStreams = false;
    const fullChanged = prevFull === null || !sameClientState(prevFull, nextFull);

    if (wantsGlobalSnapshot) {
      const next = globalClientState(nextFull);
      const stream = nextStreamSnapshot(streams[GLOBAL_CLIENT_STATE_STREAM_ID], next);
      streams[GLOBAL_CLIENT_STATE_STREAM_ID] = stream;
      didUpdateStreams = true;
      cmd.effect({ kind: 'client.snapshot', streamId: GLOBAL_CLIENT_STATE_STREAM_ID, streamSeq: stream.streamSeq, state: next });
    } else if (fullChanged && streams[GLOBAL_CLIENT_STATE_STREAM_ID]) {
      const stream = streams[GLOBAL_CLIENT_STATE_STREAM_ID];
      const next = globalClientState(nextFull);
      const patches = stream.lastState ? diffGlobalClientState(stream.lastState, next) : [];
      if (patches.length > 0) {
        const updated = nextStreamPatch(stream, next);
        streams[GLOBAL_CLIENT_STATE_STREAM_ID] = updated;
        didUpdateStreams = true;
        cmd.effect({ kind: 'client.patch', streamId: GLOBAL_CLIENT_STATE_STREAM_ID, streamSeq: updated.streamSeq, patches });
      } else if (!sameClientState(stream.lastState, next)) {
        streams[GLOBAL_CLIENT_STATE_STREAM_ID] = { ...stream, lastState: next };
        didUpdateStreams = true;
      }
    }

    for (const sessionId of collectConversationIds(prevFull, nextFull, streams, requestedConversationIds)) {
      const streamId = conversationClientStateStreamId(sessionId);
      const existing = streams[streamId];
      const requested = requestedConversationIds.has(sessionId);
      const next = conversationClientState(nextFull, sessionId);

      if (requested || (existing && existing.lastState === null)) {
        const updated = nextStreamSnapshot(existing, next);
        streams[streamId] = updated;
        didUpdateStreams = true;
        cmd.effect({ kind: 'client.snapshot', streamId, streamSeq: updated.streamSeq, state: next });
        continue;
      }

      if (!existing || !fullChanged) continue;
      const patches = existing.lastState ? diffConversationClientState(existing.lastState, next) : [];
      if (patches.length > 0) {
        const updated = nextStreamPatch(existing, next);
        streams[streamId] = updated;
        didUpdateStreams = true;
        cmd.effect({ kind: 'client.patch', streamId, streamSeq: updated.streamSeq, patches });
      } else if (!sameClientState(existing.lastState, next)) {
        streams[streamId] = { ...existing, lastState: next };
        didUpdateStreams = true;
      }
    }

    if (fullChanged || didUpdateStreams) {
      cmd.setResource(ClientSyncStateKey, {
        lastState: nextFull,
        streams
      });
    }
  }
});

function emptyReads(): AccessDeclaration {
  return { components: [], resources: [], events: [], effects: [] };
}

function projectClientState(world: WorldReader, contributors: ClientStateContributor[]): ClientState {
  const state: ClientState = emptyClientState();
  for (const contributor of contributors) {
    if (!contributor.project) {
      throw new Error(`ClientState contributor "${contributor.key}" does not provide a main-thread projector.`);
    }
    Object.assign(state, contributor.project(world));
  }
  return state;
}

function emptyClientState(): ClientState {
  return {
    agents: [],
    agentModes: [],
    toolPolicies: [],
    systemPrompts: [],
    modelProfiles: [],
    agentModeLinks: [],
    modeToolPolicyLinks: [],
    modeSystemPromptLinks: [],
    modeModelProfileLinks: [],
    sessions: [],
    agentConversationLinks: [],
    messages: [],
    toolCalls: [],
    toolCallEvents: []
  };
}

function globalClientState(state: ClientState): ClientState {
  return {
    agents: state.agents,
    agentModes: state.agentModes,
    toolPolicies: state.toolPolicies,
    systemPrompts: state.systemPrompts,
    modelProfiles: state.modelProfiles,
    agentModeLinks: state.agentModeLinks,
    modeToolPolicyLinks: state.modeToolPolicyLinks,
    modeSystemPromptLinks: state.modeSystemPromptLinks,
    modeModelProfileLinks: state.modeModelProfileLinks,
    sessions: state.sessions,
    agentConversationLinks: state.agentConversationLinks,
    messages: [],
    toolCalls: [],
    toolCallEvents: []
  };
}

function conversationClientState(state: ClientState, sessionId: string): ClientState {
  const messages = state.messages.filter((message) => message.sessionId === sessionId);
  const messageIds = new Set(messages.map((message) => message.id));
  const toolCalls = state.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
  const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
  return {
    agents: [],
    agentModes: [],
    toolPolicies: [],
    systemPrompts: [],
    modelProfiles: [],
    agentModeLinks: [],
    modeToolPolicyLinks: [],
    modeSystemPromptLinks: [],
    modeModelProfileLinks: [],
    sessions: state.sessions.filter((session) => session.id === sessionId),
    agentConversationLinks: [],
    messages,
    toolCalls,
    toolCallEvents: state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId))
  };
}

function nextStreamSnapshot(current: ClientStreamState | undefined, state: ClientState): ClientStreamState {
  return { streamSeq: (current?.streamSeq ?? 0) + 1, lastState: state };
}

function nextStreamPatch(current: ClientStreamState, state: ClientState): ClientStreamState {
  return { streamSeq: current.streamSeq + 1, lastState: state };
}

function collectConversationIds(
  prev: ClientState | null,
  next: ClientState,
  streams: Record<string, ClientStreamState>,
  requested: ReadonlySet<string>
): string[] {
  const ids = new Set<string>(requested);
  for (const session of prev?.sessions ?? []) ids.add(session.id);
  for (const session of next.sessions) ids.add(session.id);
  for (const message of prev?.messages ?? []) ids.add(message.sessionId);
  for (const message of next.messages) ids.add(message.sessionId);
  for (const streamId of Object.keys(streams)) {
    const conversationId = conversationIdFromClientStateStreamId(streamId);
    if (conversationId) ids.add(conversationId);
  }
  return [...ids];
}

function diffGlobalClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  return [
    ...diffUpsertRemove<AgentRecord, ClientPatchOp, ClientPatchOp>(
      prev.agents,
      next.agents,
      (agent): ClientPatchOp => ({ kind: 'agent.upsert', agent }),
      (id): ClientPatchOp => ({ kind: 'agent.remove', id })
    ),
    ...diffUpsertRemove<AgentModeRecord, ClientPatchOp, ClientPatchOp>(
      prev.agentModes,
      next.agentModes,
      (agentMode): ClientPatchOp => ({ kind: 'agentMode.upsert', agentMode }),
      (id): ClientPatchOp => ({ kind: 'agentMode.remove', id })
    ),
    ...diffUpsertRemove<ToolPolicyRecord, ClientPatchOp, ClientPatchOp>(
      prev.toolPolicies,
      next.toolPolicies,
      (toolPolicy): ClientPatchOp => ({ kind: 'toolPolicy.upsert', toolPolicy }),
      (id): ClientPatchOp => ({ kind: 'toolPolicy.remove', id })
    ),
    ...diffUpsertRemove<SystemPromptRecord, ClientPatchOp, ClientPatchOp>(
      prev.systemPrompts,
      next.systemPrompts,
      (systemPrompt): ClientPatchOp => ({ kind: 'systemPrompt.upsert', systemPrompt }),
      (id): ClientPatchOp => ({ kind: 'systemPrompt.remove', id })
    ),
    ...diffUpsertRemove<ModelProfileRecord, ClientPatchOp, ClientPatchOp>(
      prev.modelProfiles,
      next.modelProfiles,
      (modelProfile): ClientPatchOp => ({ kind: 'modelProfile.upsert', modelProfile }),
      (id): ClientPatchOp => ({ kind: 'modelProfile.remove', id })
    ),
    ...diffUpsertRemove<AgentModeLinkRecord, ClientPatchOp, ClientPatchOp>(
      prev.agentModeLinks,
      next.agentModeLinks,
      (link): ClientPatchOp => ({ kind: 'agentModeLink.upsert', link }),
      (id): ClientPatchOp => ({ kind: 'agentModeLink.remove', id })
    ),
    ...diffUpsertRemove<ModeToolPolicyLinkRecord, ClientPatchOp, ClientPatchOp>(
      prev.modeToolPolicyLinks,
      next.modeToolPolicyLinks,
      (link): ClientPatchOp => ({ kind: 'modeToolPolicyLink.upsert', link }),
      (id): ClientPatchOp => ({ kind: 'modeToolPolicyLink.remove', id })
    ),
    ...diffUpsertRemove<ModeSystemPromptLinkRecord, ClientPatchOp, ClientPatchOp>(
      prev.modeSystemPromptLinks,
      next.modeSystemPromptLinks,
      (link): ClientPatchOp => ({ kind: 'modeSystemPromptLink.upsert', link }),
      (id): ClientPatchOp => ({ kind: 'modeSystemPromptLink.remove', id })
    ),
    ...diffUpsertRemove<ModeModelProfileLinkRecord, ClientPatchOp, ClientPatchOp>(
      prev.modeModelProfileLinks,
      next.modeModelProfileLinks,
      (link): ClientPatchOp => ({ kind: 'modeModelProfileLink.upsert', link }),
      (id): ClientPatchOp => ({ kind: 'modeModelProfileLink.remove', id })
    ),
    ...diffUpsertRemove<SessionRecord, ClientPatchOp, ClientPatchOp>(
      prev.sessions,
      next.sessions,
      (session): ClientPatchOp => ({ kind: 'session.upsert', session }),
      (id): ClientPatchOp => ({ kind: 'session.remove', id })
    ),
    ...diffUpsertRemove<AgentConversationLinkRecord, ClientPatchOp, ClientPatchOp>(
      prev.agentConversationLinks,
      next.agentConversationLinks,
      (link): ClientPatchOp => ({ kind: 'agentConversationLink.upsert', link }),
      (id): ClientPatchOp => ({ kind: 'agentConversationLink.remove', id })
    )
  ];
}

function diffConversationClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  return [
    ...diffMessages(prev.messages, next.messages),
    ...diffUpsertRemove<ToolCallRecord, ClientPatchOp, ClientPatchOp>(
      prev.toolCalls,
      next.toolCalls,
      (toolCall): ClientPatchOp => ({ kind: 'toolcall.upsert', toolCall }),
      (id): ClientPatchOp => ({ kind: 'toolcall.remove', id })
    ),
    ...diffToolCallEvents(prev.toolCallEvents, next.toolCallEvents)
  ];
}

function diffToolCallEvents(prev: ToolCallEventRecord[], next: ToolCallEventRecord[]): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  const prevIds = new Set(prev.map((event) => event.id));
  const nextIds = new Set(next.map((event) => event.id));
  for (const event of next) {
    if (!prevIds.has(event.id)) patches.push({ kind: 'toolcallEvent.append', event });
  }
  for (const id of prevIds) {
    if (!nextIds.has(id)) patches.push({ kind: 'toolcallEvent.remove', id });
  }
  return patches;
}

function diffMessages(prev: MessageRecord[], next: MessageRecord[]): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  const prevMap = new Map(prev.map((item) => [item.id, item]));
  const nextMap = new Map(next.map((item) => [item.id, item]));
  for (const item of next) {
    const old = prevMap.get(item.id);
    if (!old) {
      patches.push({ kind: 'message.upsert', message: item });
      continue;
    }
    const oldText = messageText(old);
    const nextText = messageText(item);
    if (JSON.stringify(old.content) !== JSON.stringify(item.content)) {
      const thoughtPatch = thoughtAppendPatch(old, item);
      if (thoughtPatch) patches.push(thoughtPatch);
      else if (canAppendText(old, item) && nextText.startsWith(oldText)) patches.push({ kind: 'message.appendText', id: item.id, delta: nextText.slice(oldText.length) });
      else patches.push({ kind: 'message.upsert', message: item });
    }
    if (old.status !== item.status) patches.push({ kind: 'message.status', id: item.id, status: item.status });
  }
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) patches.push({ kind: 'message.remove', id });
  }
  return patches;
}

function messageText(message: MessageRecord): string {
  return message.content.parts
    .map((part) => isVisibleTextPart(part) ? part.text : '')
    .join('');
}

function canAppendText(prev: MessageRecord, next: MessageRecord): boolean {
  const withoutText = (message: MessageRecord) => message.content.parts.filter((part) => !isVisibleTextPart(part));
  return JSON.stringify(withoutText(prev)) === JSON.stringify(withoutText(next));
}

function thoughtAppendPatch(prev: MessageRecord, next: MessageRecord): ClientPatchOp | undefined {
  const prevParts = prev.content.parts;
  const nextParts = next.content.parts;

  if (nextParts.length === prevParts.length + 1 && sameParts(prevParts, nextParts.slice(0, -1))) {
    const part = nextParts[nextParts.length - 1];
    if (isOpenThoughtPart(part) && part.text) {
      return { kind: 'message.appendThought', id: next.id, partIndex: nextParts.length - 1, delta: part.text, ...thoughtPatchMetadata(part) };
    }
  }

  if (nextParts.length !== prevParts.length) return undefined;
  for (let index = 0; index < nextParts.length; index += 1) {
    const before = prevParts[index];
    const after = nextParts[index];
    if (!isOpenThoughtPart(before) || !isOpenThoughtPart(after)) continue;
    if (!after.text.startsWith(before.text) || after.text === before.text) continue;
    if (!sameThoughtMetadata(before, after)) continue;
    if (!sameParts(prevParts.slice(0, index), nextParts.slice(0, index))) continue;
    if (!sameParts(prevParts.slice(index + 1), nextParts.slice(index + 1))) continue;
    return { kind: 'message.appendThought', id: next.id, partIndex: index, delta: after.text.slice(before.text.length), ...thoughtPatchMetadata(after) };
  }

  return undefined;
}

function isOpenThoughtPart(part: unknown): part is TextPart {
  return !!part && typeof part === 'object' && isTextPart(part as ContentPartLike) && (part as TextPart).thought === true && (part as TextPart).thoughtDurationMs === undefined;
}

type ContentPartLike = Parameters<typeof isTextPart>[0];

function sameParts(left: unknown[], right: unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameThoughtMetadata(left: TextPart, right: TextPart): boolean {
  const { text: _leftText, ...leftMeta } = left;
  const { text: _rightText, ...rightMeta } = right;
  return JSON.stringify(leftMeta) === JSON.stringify(rightMeta);
}

function thoughtPatchMetadata(part: TextPart): Pick<Extract<ClientPatchOp, { kind: 'message.appendThought' }>, 'thoughtSignature'> {
  return {
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
  };
}

function sameClientState(left: ClientState | null, right: ClientState | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
