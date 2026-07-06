import { defineStore } from 'pinia';
import {
  CLIENT_STATE_TABLES,
  CLIENT_STATE_TABLE_KEYS,
  createEmptyClientState,
  type ClientStateSortSpec
} from '@shared/clientStateSchema';
import {
  BridgeMessageType,
  conversationIdFromClientStateStreamId,
  type CheckpointRecord,
  type CheckpointTimelineAnchorRecord,
  type ClientPatchOp,
  type ClientState,
  type ClientStateTableKey,
  type CompressionBlockRecord,
  type ConversationTimelineChunkSummaryRecord,
  type ConversationTimelinePageInfo,
  type ConversationTimelinePageRecord,
  type ConversationTimelinePatchPayload,
  type LlmInvocationRecord,
  type MessageRecord
} from '@shared/protocol';
import type { TimelineProjectionContextRecord } from '@shared/timelineProjection';
import { bridge } from '@webview/transport';
import { createClientStateDb } from './clientStateDb';

export type ConversationTimelineStatus = 'idle' | 'loadingInitial' | 'loadingOlder' | 'loadingNewer' | 'error';

type ClientStateRecord = { id: string; [key: string]: unknown };

export interface ConversationTimelineState {
  conversationId: string;
  status: ConversationTimelineStatus;
  error?: string;
  loadedChunkIds: string[];
  chunkById: Record<string, ConversationTimelineChunkSummaryRecord>;
  pageInfo?: ConversationTimelinePageInfo;
  streamSeq: number;
  /**
   * 是否已收到 conversation client stream 的完整快照。
   *
   * 仅有 patch 时 streamState 只是尾部增量；收到快照后，streamState 才能代表当前对话完整状态。
   */
  hasStreamSnapshot: boolean;
  /**
   * 已订阅 conversation client stream 的最新快照/patch 状态。
   *
   * timeline page 来自持久化分页，打开正在运行的 AgentRun 对话时可能比 live stream 更旧；
   * 因此需要单独保留 stream overlay，并在 page replace 后重新覆盖回展示 state。
   */
  streamState: ClientState;
  state: ClientState;
  projections: Record<string, TimelineProjectionContextRecord>;
}

interface ConversationTimelineStoreState {
  byConversationId: Record<string, ConversationTimelineState>;
  currentConversationId: string;
}

const DEFAULT_INITIAL_CHUNK_COUNT = 2;
const DEFAULT_INCREMENTAL_CHUNK_COUNT = 2;
const TIMELINE_PROJECTIONS = ['task-list'];

interface PendingClientStatePatchBatch {
  streamId: string;
  streamSeq: number;
  patches: ClientPatchOp[];
  frameId?: number;
}

const pendingClientStatePatchBatches = new Map<string, PendingClientStatePatchBatch>();

export const useConversationTimelineStore = defineStore('conversationTimeline', {
  state: (): ConversationTimelineStoreState => ({
    byConversationId: {},
    currentConversationId: ''
  }),
  getters: {
    currentTimeline(state): ConversationTimelineState {
      return state.currentConversationId
        ? state.byConversationId[state.currentConversationId] ?? createTimelineState(state.currentConversationId)
        : createTimelineState('');
    },
    currentTimelineState(): ClientState {
      return this.currentTimeline.state;
    },
    currentMessages(): MessageRecord[] {
      const state = this.currentTimeline.state;
      return this.currentTimeline.state.messages
        .filter((message) => message.conversationId === this.currentConversationId)
        .filter((message) => !message.content.parts.some((part) => 'functionResponse' in part))
        .filter((message) => !isPreStartEmptyModelMessage(message, state))
        .sort(compareMessages);
    },
    currentAnchorMessages(): MessageRecord[] {
      const state = this.currentTimeline.state;
      return this.currentTimeline.state.messages
        .filter((message) => message.conversationId === this.currentConversationId)
        .filter((message) => !isPreStartEmptyModelMessage(message, state))
        .sort(compareMessages);
    },
    currentCheckpoints(): CheckpointRecord[] {
      return this.currentTimeline.state.checkpoints
        .filter((checkpoint) => checkpoint.conversationId === this.currentConversationId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentCheckpointTimelineAnchors(): CheckpointTimelineAnchorRecord[] {
      return this.currentTimeline.state.checkpointTimelineAnchors
        .filter((anchor) => anchor.conversationId === this.currentConversationId)
        .sort((left, right) => left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentCompressionBlocks(): CompressionBlockRecord[] {
      return this.currentTimeline.state.compressionBlocks
        .filter((block) => block.conversationId === this.currentConversationId)
        .sort((left, right) => (left.anchorSeq ?? left.endSeq ?? 0) - (right.anchorSeq ?? right.endSeq ?? 0) || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentMessageFloorById(): Record<string, number> {
      const timeline = this.currentTimeline;
      const result: Record<string, number> = {};
      const chunks = timeline.loadedChunkIds
        .map((id) => timeline.chunkById[id])
        .filter((chunk): chunk is ConversationTimelineChunkSummaryRecord => !!chunk)
        .sort((left, right) => left.index - right.index);
      const messages = this.currentMessages;
      for (const chunk of chunks) {
        const inChunk = messages
          .filter((message) => message.seq >= chunk.startSeq && message.seq <= chunk.endSeq)
          .sort(compareMessages);
        inChunk.forEach((message, index) => {
          result[message.id] = chunk.messageOffsetStart + index;
        });
      }
      let nextFloor = Math.max(0, ...Object.values(result));
      for (const message of messages) {
        if (result[message.id] !== undefined) continue;
        nextFloor += 1;
        result[message.id] = nextFloor;
      }
      return result;
    },
    currentTotalMessages(): number {
      const loadedMax = Math.max(0, ...Object.values(this.currentMessageFloorById));
      return Math.max(this.currentTimeline.pageInfo?.totalMessages ?? 0, loadedMax);
    },
    currentTaskListProjection(): TimelineProjectionContextRecord | undefined {
      return this.currentTimeline.projections['task-list'];
    },
    currentLoadedMessageCount(): number {
      return this.currentMessages.length;
    },
    currentHasOlder(): boolean {
      return this.currentTimeline.pageInfo?.hasOlder === true;
    },
    currentHasNewer(): boolean {
      return this.currentTimeline.pageInfo?.hasNewer === true;
    }
  },
  actions: {
    setCurrentConversation(conversationId: string): void {
      this.currentConversationId = conversationId;
      if (conversationId) this.ensureTimeline(conversationId);
    },
    requestInitial(conversationId: string, chunkCount = DEFAULT_INITIAL_CHUNK_COUNT): void {
      if (!conversationId) return;
      const timeline = this.ensureTimeline(conversationId);
      if (timeline.pageInfo !== undefined) {
        timeline.status = 'idle';
        timeline.error = undefined;
        return;
      }
      if (timeline.status === 'loadingInitial') return;
      timeline.status = 'loadingInitial';
      timeline.error = undefined;
      bridge.request(BridgeMessageType.ConversationTimelinePageGet, {
        conversationId,
        direction: 'initial',
        chunkCount,
        includeProjections: TIMELINE_PROJECTIONS
      }, { channel: 'state' });
    },
    requestOlder(conversationId?: string): void {
      const targetConversationId = conversationId || this.currentConversationId;
      const timeline = this.ensureTimeline(targetConversationId);
      if (!targetConversationId || timeline.status === 'loadingOlder' || timeline.pageInfo?.hasOlder === false) return;
      const oldest = oldestLoadedChunk(timeline);
      timeline.status = 'loadingOlder';
      timeline.error = undefined;
      bridge.request(BridgeMessageType.ConversationTimelinePageGet, {
        conversationId: targetConversationId,
        direction: 'older',
        cursor: oldest?.id,
        chunkCount: DEFAULT_INCREMENTAL_CHUNK_COUNT,
        includeProjections: TIMELINE_PROJECTIONS
      }, { channel: 'state' });
    },
    requestNewer(conversationId?: string): void {
      const targetConversationId = conversationId || this.currentConversationId;
      const timeline = this.ensureTimeline(targetConversationId);
      if (!targetConversationId || timeline.status === 'loadingNewer' || timeline.pageInfo?.hasNewer === false) return;
      const newest = newestLoadedChunk(timeline);
      timeline.status = 'loadingNewer';
      timeline.error = undefined;
      bridge.request(BridgeMessageType.ConversationTimelinePageGet, {
        conversationId: targetConversationId,
        direction: 'newer',
        cursor: newest?.id,
        chunkCount: DEFAULT_INCREMENTAL_CHUNK_COUNT,
        includeProjections: TIMELINE_PROJECTIONS
      }, { channel: 'state' });
    },
    requestAround(conversationId: string, messageId: string): void {
      if (!conversationId || !messageId) return;
      const timeline = this.ensureTimeline(conversationId);
      timeline.status = 'loadingInitial';
      timeline.error = undefined;
      bridge.request(BridgeMessageType.ConversationTimelinePageGet, {
        conversationId,
        direction: 'around',
        anchorMessageId: messageId,
        chunkCount: DEFAULT_INCREMENTAL_CHUNK_COUNT,
        includeProjections: TIMELINE_PROJECTIONS
      }, { channel: 'state' });
    },
    applyPageSnapshot(page: ConversationTimelinePageRecord): void {
      const timeline = this.ensureTimeline(page.conversationId);
      if (page.applyMode === 'replace') {
        timeline.state = createEmptyClientState();
        timeline.loadedChunkIds = [];
        timeline.chunkById = {};
        timeline.projections = {};
      }
      mergeClientState(timeline.state, page.state);
      for (const chunk of page.chunks) timeline.chunkById[chunk.id] = chunk;
      timeline.loadedChunkIds = Object.values(timeline.chunkById)
        .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
        .map((chunk) => chunk.id);
      timeline.pageInfo = mergePageInfo(timeline, page.pageInfo);
      pruneClientStateToTimelineWindow(timeline, timeline.streamState);
      if (timeline.hasStreamSnapshot) {
        removeStaleConversationStreamMessages(timeline, page.conversationId, timeline.streamState, {
          rawConversationMessageCount: timeline.streamState.messages.filter((message) => message.conversationId === page.conversationId).length,
          rawHasConversation: false
        });
      }
      // 持久化分页可能晚于 live conversation stream 到达。重新叠加 streamState，避免
      // AgentRun 新对话里已经显示的实时消息被空/陈旧的 replace page 快照清掉。
      mergeClientState(timeline.state, timeline.streamState);
      pruneClientStateToTimelineWindow(timeline, timeline.state);
      timeline.projections = { ...timeline.projections, ...(page.projections ?? {}) };
      timeline.status = 'idle';
      timeline.error = undefined;
    },
    applyTimelinePatch(payload: ConversationTimelinePatchPayload): void {
      const timeline = this.ensureTimeline(payload.conversationId);
      if (payload.streamSeq > 0 && payload.streamSeq <= timeline.streamSeq) return;
      createClientStateDb(timeline.state).applyPatches(payload.patches);
      timeline.streamSeq = payload.streamSeq;
      if (payload.pageInfo) timeline.pageInfo = { ...(timeline.pageInfo ?? createEmptyPageInfo(payload.conversationId)), ...payload.pageInfo };
      pruneClientStateToTimelineWindow(timeline, timeline.state);
    },
    applyClientStateSnapshot(streamId: string, streamSeq: number, state: ClientState): void {
      const conversationId = conversationIdFromClientStateStreamId(streamId);
      if (!conversationId) return;
      clearPendingClientStatePatch(streamId);
      const timeline = this.ensureTimeline(conversationId);
      if (streamSeq > 0 && streamSeq <= timeline.streamSeq && timeline.hasStreamSnapshot) return;
      const rawConversationMessageCount = state.messages.filter((message) => message.conversationId === conversationId).length;
      const rawHasConversation = state.conversations.some((conversation) => conversation.id === conversationId);
      timeline.streamState = createEmptyClientState();
      mergeClientState(timeline.streamState, state);
      pruneClientStateToTimelineWindow(timeline, timeline.streamState);
      timeline.hasStreamSnapshot = true;
      // Page snapshots own chunk cursors and global floor offsets; stream snapshots only overlay live ECS state.
      if (timeline.loadedChunkIds.length === 0) {
        timeline.state = createEmptyClientState();
      } else {
        removeStaleConversationStreamMessages(timeline, conversationId, timeline.streamState, {
          rawConversationMessageCount,
          rawHasConversation
        });
      }
      mergeClientState(timeline.state, timeline.streamState);
      pruneClientStateToTimelineWindow(timeline, timeline.state);
      timeline.streamSeq = streamSeq;
      if (timeline.pageInfo === undefined && timeline.status !== 'loadingInitial') {
        this.requestInitial(conversationId);
      }
    },
    applyClientStatePatch(streamId: string, streamSeq: number, patches: ClientPatchOp[]): void {
      const conversationId = conversationIdFromClientStateStreamId(streamId);
      if (!conversationId) return;
      const timeline = this.ensureTimeline(conversationId);
      const pending = pendingClientStatePatchBatches.get(streamId);
      const latestSeq = pending?.streamSeq ?? timeline.streamSeq;
      if (streamSeq > 0 && streamSeq <= latestSeq) return;

      const batch = pending ?? { streamId, streamSeq: timeline.streamSeq, patches: [] };
      batch.streamSeq = streamSeq;
      batch.patches.push(...patches);
      pendingClientStatePatchBatches.set(streamId, batch);
      if (batch.frameId !== undefined) return;
      batch.frameId = window.requestAnimationFrame(() => {
        batch.frameId = undefined;
        this.flushPendingClientStatePatch(streamId);
      });
    },
    flushPendingClientStatePatch(streamId: string): void {
      const conversationId = conversationIdFromClientStateStreamId(streamId);
      if (!conversationId) return;
      const batch = pendingClientStatePatchBatches.get(streamId);
      if (!batch) return;
      pendingClientStatePatchBatches.delete(streamId);
      const timeline = this.ensureTimeline(conversationId);
      if (batch.streamSeq > 0 && batch.streamSeq <= timeline.streamSeq) return;
      createClientStateDb(timeline.streamState).applyPatches(batch.patches);
      pruneClientStateToTimelineWindow(timeline, timeline.streamState);
      createClientStateDb(timeline.state).applyPatches(batch.patches);
      pruneClientStateToTimelineWindow(timeline, timeline.state);
      timeline.streamSeq = batch.streamSeq;
    },
    setError(conversationId: string | undefined, message: string): void {
      const target = conversationId ? this.ensureTimeline(conversationId) : this.currentTimeline;
      target.status = 'error';
      target.error = message;
    },
    ensureTimeline(conversationId: string): ConversationTimelineState {
      const existing = this.byConversationId[conversationId];
      if (existing) return existing;
      const next = createTimelineState(conversationId);
      this.byConversationId[conversationId] = next;
      return next;
    }
  }
});

function clearPendingClientStatePatch(streamId: string): void {
  const batch = pendingClientStatePatchBatches.get(streamId);
  if (!batch) return;
  if (batch.frameId !== undefined) window.cancelAnimationFrame(batch.frameId);
  pendingClientStatePatchBatches.delete(streamId);
}

function createTimelineState(conversationId: string): ConversationTimelineState {
  return {
    conversationId,
    status: 'idle',
    loadedChunkIds: [],
    chunkById: {},
    streamSeq: 0,
    hasStreamSnapshot: false,
    streamState: createEmptyClientState(),
    state: createEmptyClientState(),
    projections: {}
  };
}

function createEmptyPageInfo(conversationId: string): ConversationTimelinePageInfo {
  return {
    conversationId,
    chunkIds: [],
    totalChunks: 0,
    totalMessages: 0,
    hasOlder: false,
    hasNewer: false,
    loadedAt: Date.now()
  };
}

interface TimelineSeqWindow {
  startSeq: number;
  endSeq: number;
  includesTail: boolean;
}

function timelineSeqWindow(timeline: ConversationTimelineState): TimelineSeqWindow | undefined {
  const chunks = timeline.loadedChunkIds
    .map((id) => timeline.chunkById[id])
    .filter((chunk): chunk is ConversationTimelineChunkSummaryRecord => !!chunk);
  if (chunks.length === 0) return undefined;
  return {
    startSeq: Math.min(...chunks.map((chunk) => chunk.startSeq)),
    endSeq: Math.max(...chunks.map((chunk) => chunk.endSeq)),
    includesTail: timeline.pageInfo?.hasNewer === false
  };
}

function pruneClientStateToTimelineWindow(timeline: ConversationTimelineState, state: ClientState): void {
  const window = timelineSeqWindow(timeline);
  if (!window) return;

  state.messages = state.messages.filter((message) =>
    message.conversationId !== timeline.conversationId || seqInTimelineWindow(message.seq, window)
  );
  const messageIds = new Set(state.messages.map((message) => message.id));

  state.messageRevisions = state.messageRevisions.filter((revision) =>
    revision.conversationId !== timeline.conversationId || messageIds.has(revision.messageId)
  );
  const revisionIds = new Set(state.messageRevisions.map((revision) => revision.id));
  state.messageCurrentRevisionLinks = state.messageCurrentRevisionLinks.filter((link) =>
    messageIds.has(link.messageId) || revisionIds.has(link.revisionId)
  );
  state.toolCalls = state.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
  const toolCallIds = new Set(state.toolCalls.map((toolCall) => toolCall.id));
  state.toolCallEvents = state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId));
  state.toolCallRunLinks = state.toolCallRunLinks.filter((link) => toolCallIds.has(link.toolCallId));
  state.messageRunLinks = state.messageRunLinks.filter((link) => messageIds.has(link.messageId));
  state.messageLlmInvocationLinks = state.messageLlmInvocationLinks.filter((link) => messageIds.has(link.messageId));

  state.compressionBlocks = state.compressionBlocks.filter((block) =>
    block.conversationId !== timeline.conversationId || compressionBlockInTimelineWindow(block, window)
  );
  const compressionBlockIds = new Set(state.compressionBlocks.map((block) => block.id));
  state.compressionBlockSourceLinks = state.compressionBlockSourceLinks.filter((link) => compressionBlockIds.has(link.blockId));
  state.compressionBlockLlmInvocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => compressionBlockIds.has(link.blockId));
  state.compressionContextVariants = state.compressionContextVariants.filter((variant) => compressionBlockIds.has(variant.blockId));
  state.runCompressionBlockLinks = state.runCompressionBlockLinks.filter((link) => compressionBlockIds.has(link.blockId));
}

function removeStaleConversationStreamMessages(
  timeline: ConversationTimelineState,
  conversationId: string,
  streamState: ClientState,
  raw: { rawConversationMessageCount: number; rawHasConversation: boolean }
): void {
  const incomingMessages = streamState.messages.filter((message) => message.conversationId === conversationId);
  const existingMessages = timeline.state.messages.filter((message) => message.conversationId === conversationId);
  if (existingMessages.length === 0) return;

  const staleIds = incomingMessages.length > 0
    ? staleMessageIdsCoveredByStream(existingMessages, incomingMessages)
    : raw.rawHasConversation && raw.rawConversationMessageCount === 0
      ? existingMessages.map((message) => message.id)
      : [];
  if (staleIds.length === 0) return;

  createClientStateDb(timeline.state).applyPatches(staleIds.map((id): ClientPatchOp => ({ kind: 'message.remove', id })));
}

function staleMessageIdsCoveredByStream(existingMessages: MessageRecord[], incomingMessages: MessageRecord[]): string[] {
  const incomingIds = new Set(incomingMessages.map((message) => message.id));
  const minIncomingSeq = Math.min(...incomingMessages.map((message) => message.seq));
  return existingMessages
    .filter((message) => message.seq >= minIncomingSeq && !incomingIds.has(message.id))
    .map((message) => message.id);
}

function seqInTimelineWindow(seq: number, window: TimelineSeqWindow): boolean {
  if (seq >= window.startSeq && seq <= window.endSeq) return true;
  return window.includesTail && seq > window.endSeq;
}

function compressionBlockInTimelineWindow(block: CompressionBlockRecord, window: TimelineSeqWindow): boolean {
  const seq = block.anchorSeq ?? block.endSeq;
  return seq !== undefined && seqInTimelineWindow(seq, window);
}

function mergeClientState(target: ClientState, source: ClientState): void {
  for (const key of CLIENT_STATE_TABLE_KEYS) {
    const targetList = target[key] as ClientStateRecord[];
    const sourceList = source[key] as ClientStateRecord[];
    upsertAll(targetList, sourceList);
    sortTable(key, targetList);
  }
}

function upsertAll<T extends { id: string }>(target: T[], source: T[]): void {
  if (source.length === 0) return;
  if (target.length === 0) {
    target.push(...source.map(cloneRecord));
    return;
  }

  const indexById = new Map<string, number>();
  target.forEach((item, index) => indexById.set(item.id, index));
  for (const item of source) {
    const next = cloneRecord(item);
    const index = indexById.get(item.id);
    if (index !== undefined) {
      target[index] = next;
      continue;
    }
    indexById.set(item.id, target.length);
    target.push(next);
  }
}

function cloneRecord<T extends { id: string }>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}

function sortTable(tableKey: ClientStateTableKey, list: ClientStateRecord[]): void {
  const orderBy = CLIENT_STATE_TABLES[tableKey].clientSync.orderBy;
  if (!orderBy?.length) return;
  list.sort((left, right) => compareRecords(left, right, orderBy));
}

function compareRecords(left: ClientStateRecord, right: ClientStateRecord, orderBy: readonly ClientStateSortSpec[]): number {
  for (const sort of orderBy) {
    const result = compareValues(left[sort.field], right[sort.field]);
    if (result !== 0) return sort.direction === 'desc' ? -result : result;
  }
  return 0;
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function mergePageInfo(timeline: ConversationTimelineState, incoming: ConversationTimelinePageInfo): ConversationTimelinePageInfo {
  const chunks = timeline.loadedChunkIds
    .map((id) => timeline.chunkById[id])
    .filter((chunk): chunk is ConversationTimelineChunkSummaryRecord => !!chunk)
    .sort((left, right) => left.index - right.index);
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  return {
    ...incoming,
    chunkIds: chunks.map((chunk) => chunk.id),
    ...(first ? { startSeq: first.startSeq, oldestChunkId: first.id, previousCursor: first.id } : {}),
    ...(last ? { endSeq: last.endSeq, newestChunkId: last.id, nextCursor: last.id } : {}),
    hasOlder: first ? first.index > 0 : incoming.hasOlder,
    hasNewer: last ? last.index < incoming.totalChunks - 1 : incoming.hasNewer
  };
}

function oldestLoadedChunk(timeline: ConversationTimelineState): ConversationTimelineChunkSummaryRecord | undefined {
  return timeline.loadedChunkIds
    .map((id) => timeline.chunkById[id])
    .filter((chunk): chunk is ConversationTimelineChunkSummaryRecord => !!chunk)
    .sort((left, right) => left.index - right.index)[0];
}

function newestLoadedChunk(timeline: ConversationTimelineState): ConversationTimelineChunkSummaryRecord | undefined {
  return timeline.loadedChunkIds
    .map((id) => timeline.chunkById[id])
    .filter((chunk): chunk is ConversationTimelineChunkSummaryRecord => !!chunk)
    .sort((left, right) => right.index - left.index)[0];
}

function compareMessages(left: MessageRecord, right: MessageRecord): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function isPreStartEmptyModelMessage(message: MessageRecord, state: ClientState): boolean {
  if (message.role !== 'model' || message.status !== 'streaming' || message.content.parts.length > 0) return false;
  const invocation = invocationForMessage(message.id, state);
  return !!invocation && invocation.status !== 'streaming';
}

function invocationForMessage(messageId: string, state: ClientState): LlmInvocationRecord | undefined {
  const link = state.messageLlmInvocationLinks.find((candidate) => candidate.messageId === messageId);
  if (!link) return undefined;
  return state.llmInvocations.find((invocation) => invocation.id === link.invocationId);
}
