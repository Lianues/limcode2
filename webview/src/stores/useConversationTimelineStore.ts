import { defineStore } from 'pinia';
import {
  CLIENT_STATE_TABLES,
  CLIENT_STATE_TABLE_KEYS,
  GENERIC_CLIENT_PATCH_APPLY_BY_KIND,
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
  type ConversationTimelineMetaRecord,
  type ConversationTimelinePageDirection,
  type ConversationTimelinePageInfo,
  type ConversationTimelinePageRecord,
  type ConversationTimelinePatchPayload,
  type LlmInvocationRecord,
  type MessageRecord
} from '@shared/protocol';
import type { TimelineProjectionContextRecord } from '@shared/timelineProjection';
import {
  conversationTimelineStateForMessageIds,
  createConversationTimelineSeqWindow,
  seqInConversationTimelineWindow,
  timelineHasNewerChunks,
  timelineHasOlderChunks
} from '@shared/conversationTimelineWindow';
import { bridge } from '@webview/transport';
import { createClientStateDb } from './clientStateDb';
import { areTimelineWindowStablePatches, compactClientPatchOps } from './clientPatchCompaction';

export type ConversationTimelineStatus = 'idle' | 'loadingInitial' | 'loadingOlder' | 'loadingNewer' | 'error';

type ClientStateRecord = { id: string; [key: string]: unknown };

export interface ConversationTimelineState {
  conversationId: string;
  status: ConversationTimelineStatus;
  error?: string;
  loadedChunkIds: string[];
  chunkById: Record<string, ConversationTimelineChunkSummaryRecord>;
  pageInfo?: ConversationTimelinePageInfo;
  meta?: ConversationTimelineMetaRecord;
  pendingPageDirection?: ConversationTimelinePageDirection;
  initialRefreshPending: boolean;
  historyExpanded: boolean;
  tailAttached: boolean;
  tailCatchupPending: boolean;
  prependRevision: number;
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
  pageState: ClientState;
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
const MAX_TAIL_RESIDENT_CHUNKS = 4;
const TIMELINE_PROJECTIONS = ['task-list'];
const PAGE_OWNED_TABLE_KEYS = [
  'messages',
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'toolCalls',
  'toolCallEvents',
  'projectContexts',
  'shadowRepositories',
  'conversationCheckpointRepositoryLinks',
  'checkpoints',
  'checkpointTimelineAnchors',
  'compressionBlocks',
  'compressionBlockSourceLinks',
  'compressionContextVariants',
  'compressionBlockLlmInvocationLinks',
  'llmInvocations'
] as const satisfies readonly ClientStateTableKey[];

interface PendingClientStatePatchBatch {
  streamId: string;
  streamSeq: number;
  patches: ClientPatchOp[];
  windowEvictedMessageIds: string[];
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
      const timeline = this.currentTimeline;
      const window = createConversationTimelineSeqWindow(loadedChunks(timeline), timeline.tailAttached);
      return timeline.state.compressionBlocks
        .filter((block) => block.conversationId === this.currentConversationId)
        .filter((block) => {
          if (!window) return true;
          const seq = block.anchorSeq ?? block.endSeq;
          return seq !== undefined && seqInConversationTimelineWindow(seq, window);
        })
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
      return timelineHasOlder(this.currentTimeline);
    },
    currentHasNewer(): boolean {
      return timelineHasNewer(this.currentTimeline);
    }
  },
  actions: {
    setCurrentConversation(conversationId: string): void {
      this.currentConversationId = conversationId;
      if (conversationId) this.ensureTimeline(conversationId);
    },
    requestInitial(
      conversationId: string,
      chunkCount = DEFAULT_INITIAL_CHUNK_COUNT,
      options: { force?: boolean } = {}
    ): void {
      if (!conversationId) return;
      const timeline = this.ensureTimeline(conversationId);
      if (timeline.pageInfo !== undefined && !options.force) {
        timeline.status = 'idle';
        timeline.error = undefined;
        this.maybeRequestTailCatchup(conversationId);
        return;
      }
      if (isTimelineLoading(timeline.status)) {
        if (options.force) timeline.initialRefreshPending = true;
        return;
      }
      timeline.initialRefreshPending = false;
      timeline.status = 'loadingInitial';
      timeline.pendingPageDirection = 'initial';
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
      if (!targetConversationId) return;
      const timeline = this.ensureTimeline(targetConversationId);
      if (isTimelineLoading(timeline.status) || !timelineHasOlder(timeline)) return;
      const oldest = oldestLoadedChunk(timeline);
      timeline.historyExpanded = true;
      timeline.status = 'loadingOlder';
      timeline.pendingPageDirection = 'older';
      timeline.error = undefined;
      bridge.request(BridgeMessageType.ConversationTimelinePageGet, {
        conversationId: targetConversationId,
        direction: 'older',
        cursor: oldest?.id,
        chunkCount: DEFAULT_INCREMENTAL_CHUNK_COUNT,
        includeProjections: TIMELINE_PROJECTIONS
      }, { channel: 'state' });
    },
    requestNewer(conversationId?: string, options: { force?: boolean } = {}): void {
      const targetConversationId = conversationId || this.currentConversationId;
      if (!targetConversationId) return;
      const timeline = this.ensureTimeline(targetConversationId);
      if (isTimelineLoading(timeline.status)) return;
      if (!options.force && !timelineHasNewer(timeline)) return;
      const newest = newestLoadedChunk(timeline);
      if (!newest) return;
      timeline.status = 'loadingNewer';
      timeline.pendingPageDirection = 'newer';
      timeline.tailCatchupPending = false;
      timeline.error = undefined;
      bridge.request(BridgeMessageType.ConversationTimelinePageGet, {
        conversationId: targetConversationId,
        direction: 'newer',
        cursor: newest.id,
        chunkCount: DEFAULT_INCREMENTAL_CHUNK_COUNT,
        includeProjections: TIMELINE_PROJECTIONS
      }, { channel: 'state' });
    },
    requestAround(conversationId: string, messageId: string): void {
      if (!conversationId || !messageId) return;
      const timeline = this.ensureTimeline(conversationId);
      if (isTimelineLoading(timeline.status)) return;
      timeline.historyExpanded = true;
      timeline.status = 'loadingInitial';
      timeline.pendingPageDirection = 'around';
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
      const previousNewest = newestLoadedChunk(timeline);
      const direction = timeline.pendingPageDirection ?? directionForApplyMode(page.applyMode);
      timeline.pendingPageDirection = undefined;

      if (page.applyMode === 'replace') {
        timeline.pageState = createEmptyClientState();
        timeline.state = createEmptyClientState();
        timeline.loadedChunkIds = [];
        timeline.chunkById = {};
        timeline.projections = {};
        timeline.historyExpanded = direction === 'around';
        timeline.tailAttached = direction === 'initial';
        timeline.tailCatchupPending = false;
      }

      mergeClientState(timeline.pageState, page.state);
      for (const chunk of page.chunks) timeline.chunkById[chunk.id] = chunk;
      timeline.loadedChunkIds = Object.values(timeline.chunkById)
        .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
        .map((chunk) => chunk.id);
      if (direction === 'newer') trimAutomaticTailChunks(timeline);
      timeline.pageInfo = mergePageInfo(timeline, page.pageInfo);
      pruneClientStateToTimelineWindow(timeline, timeline.pageState, false);

      // Page 只拥有已加载 chunk；stream 只作为覆盖层。prepend older 时绝不能
      // 根据持久化 hasNewer 把实时尾部从展示 state 中裁掉。
      mergeClientState(timeline.state, timeline.pageState);
      if (timeline.hasStreamSnapshot) {
        removeStaleConversationStreamMessages(timeline, page.conversationId, timeline.streamState, {
          rawConversationMessageCount: timeline.streamState.messages.filter((message) => message.conversationId === page.conversationId).length,
          rawHasConversation: false
        });
      }
      mergeClientState(timeline.state, timeline.streamState);
      pruneClientStateToTimelineWindow(timeline, timeline.state, timeline.tailAttached);
      timeline.projections = { ...timeline.projections, ...(page.projections ?? {}) };
      if (direction === 'older' && page.chunks.length > 0) timeline.prependRevision += 1;
      timeline.status = 'idle';
      timeline.error = undefined;
      if (timeline.initialRefreshPending) {
        this.requestInitial(page.conversationId, DEFAULT_INITIAL_CHUNK_COUNT, { force: true });
        return;
      }
      const newerAdvanced = direction !== 'newer' || didNewestChunkAdvance(previousNewest, newestLoadedChunk(timeline));
      timeline.tailCatchupPending = timeline.tailAttached && timelineHasNewer(timeline) && newerAdvanced;
      if (timeline.tailCatchupPending) this.maybeRequestTailCatchup(page.conversationId);
    },
    applyTimelinePatch(payload: ConversationTimelinePatchPayload): void {
      const timeline = this.ensureTimeline(payload.conversationId);
      if (payload.streamSeq > 0 && payload.streamSeq <= timeline.streamSeq) return;
      createClientStateDb(timeline.state).applyPatches(payload.patches);
      if (payload.streamSeq > 0) timeline.streamSeq = payload.streamSeq;
      if (payload.pageInfo) timeline.pageInfo = mergePageInfo(
        timeline,
        { ...(timeline.pageInfo ?? createEmptyPageInfo(payload.conversationId)), ...payload.pageInfo }
      );
      pruneClientStateToTimelineWindow(timeline, timeline.state, timeline.tailAttached);
    },
    applyTimelineMeta(metadata: ConversationTimelineMetaRecord): void {
      const timeline = this.ensureTimeline(metadata.conversationId);
      if (timeline.meta?.revision === metadata.revision) return;
      if (timeline.meta && metadata.committedAt < timeline.meta.committedAt) return;
      const previousTotalChunks = knownTimelineTotalChunks(timeline);
      const previousTotalMessages = knownTimelineTotalMessages(timeline);
      timeline.meta = cloneValue(metadata);
      timeline.pageInfo = mergePageInfoWithMeta(timeline, timeline.pageInfo, metadata);

      const timelineShrank = metadata.totalChunks < previousTotalChunks
        || metadata.totalMessages < previousTotalMessages;
      if (timelineShrank && timeline.loadedChunkIds.length > 0) {
        timeline.tailAttached = true;
        timeline.tailCatchupPending = false;
        this.requestInitial(metadata.conversationId, DEFAULT_INITIAL_CHUNK_COUNT, { force: true });
        return;
      }

      timeline.tailCatchupPending = timeline.tailAttached && timelineHasNewer(timeline);
      this.maybeRequestTailCatchup(metadata.conversationId);
    },
    maybeRequestTailCatchup(conversationId: string): void {
      const timeline = this.ensureTimeline(conversationId);
      if (!timeline.tailAttached || !timelineHasNewer(timeline)) {
        timeline.tailCatchupPending = false;
        return;
      }
      timeline.tailCatchupPending = true;
      if (isTimelineLoading(timeline.status)) return;
      this.requestNewer(conversationId, { force: true });
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
      timeline.hasStreamSnapshot = true;

      // stream snapshot 只精确覆盖最近窗口；窗口 floor 之前的 page/已保留尾部记录不能按“快照缺失”删除。
      if (timeline.loadedChunkIds.length === 0) {
        timeline.state = createEmptyClientState();
      } else {
        removeStaleConversationStreamMessages(timeline, conversationId, timeline.streamState, {
          rawConversationMessageCount,
          rawHasConversation
        });
      }
      mergeClientState(timeline.state, timeline.streamState);
      pruneClientStateToTimelineWindow(timeline, timeline.state, timeline.tailAttached);
      timeline.streamSeq = streamSeq;
      if (timeline.pageInfo === undefined && timeline.status !== 'loadingInitial') {
        this.requestInitial(conversationId);
      } else {
        this.maybeRequestTailCatchup(conversationId);
      }
    },
    applyClientStatePatch(
      streamId: string,
      streamSeq: number,
      patches: ClientPatchOp[],
      windowEvictedMessageIds: readonly string[] = []
    ): void {
      const conversationId = conversationIdFromClientStateStreamId(streamId);
      if (!conversationId) return;
      const timeline = this.ensureTimeline(conversationId);
      const pending = pendingClientStatePatchBatches.get(streamId);
      const latestSeq = pending?.streamSeq ?? timeline.streamSeq;
      if (streamSeq > 0 && streamSeq <= latestSeq) return;

      const batch = pending ?? { streamId, streamSeq: timeline.streamSeq, patches: [], windowEvictedMessageIds: [] };
      batch.streamSeq = streamSeq;
      batch.patches.push(...patches);
      batch.windowEvictedMessageIds.push(...windowEvictedMessageIds);
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
      const patches = compactClientPatchOps(batch.patches);
      const windowStable = areTimelineWindowStablePatches(patches);
      if (windowStable) {
        createClientStateDb(timeline.streamState).applyPatches(patches);
        createClientStateDb(timeline.state).applyPatches(patches);
        timeline.streamSeq = batch.streamSeq;
        return;
      }

      const evictedMessageIds = new Set(batch.windowEvictedMessageIds);
      // 从固定 240 条的 previous stream window 提取，避免用户已展开大量历史后每条新消息都扫描完整页面状态。
      const retainedState = conversationTimelineStateForMessageIds(timeline.streamState, evictedMessageIds);
      createClientStateDb(timeline.streamState).applyPatches(patches);

      // pageState 只接受删除；实时 upsert/mutation 仍由 stream 覆盖。窗口淘汰关联的
      // remove 在应用后重新恢复，真正的编辑/删除/重试则会永久清理 page-owned 数据。
      const removalPatches = patches.filter(isGenericClientRemovePatch);
      createClientStateDb(timeline.pageState).applyPatches(removalPatches);
      mergeClientStateTables(timeline.pageState, retainedState, PAGE_OWNED_TABLE_KEYS);
      pruneClientStateToTimelineWindow(timeline, timeline.pageState, false);

      createClientStateDb(timeline.state).applyPatches(patches);
      mergeClientState(timeline.state, retainedState);
      pruneClientStateToTimelineWindow(timeline, timeline.state, timeline.tailAttached);
      timeline.streamSeq = batch.streamSeq;
      this.maybeRequestTailCatchup(conversationId);
    },
    setError(conversationId: string | undefined, message: string): void {
      const target = conversationId ? this.ensureTimeline(conversationId) : this.currentTimeline;
      target.status = 'error';
      target.pendingPageDirection = undefined;
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
    initialRefreshPending: false,
    historyExpanded: false,
    tailAttached: false,
    tailCatchupPending: false,
    prependRevision: 0,
    streamSeq: 0,
    hasStreamSnapshot: false,
    pageState: createEmptyClientState(),
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

function pruneClientStateToTimelineWindow(
  timeline: ConversationTimelineState,
  state: ClientState,
  tailAttached: boolean
): void {
  const window = createConversationTimelineSeqWindow(loadedChunks(timeline), tailAttached);
  if (!window) return;

  state.messages = state.messages.filter((message) =>
    message.conversationId !== timeline.conversationId || seqInConversationTimelineWindow(message.seq, window)
  );
  const messageIds = new Set(state.messages.map((message) => message.id));

  state.messageRevisions = state.messageRevisions.filter((revision) =>
    revision.conversationId !== timeline.conversationId || messageIds.has(revision.messageId)
  );
  const revisionIds = new Set(state.messageRevisions.map((revision) => revision.id));
  state.messageCurrentRevisionLinks = state.messageCurrentRevisionLinks.filter((link) =>
    messageIds.has(link.messageId) || revisionIds.has(link.revisionId)
  );
  const runIds = new Set(state.agentRuns.map((run) => run.id));
  // 对话流会额外投影关联子 Run 的当前工具；它们的 message 属于子对话，不能按当前消息窗口裁掉。
  const runToolCallIds = new Set(
    state.toolCallRunLinks
      .filter((link) => runIds.has(link.runId))
      .map((link) => link.toolCallId)
  );
  state.toolCalls = state.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId) || runToolCallIds.has(toolCall.id));
  const toolCallIds = new Set(state.toolCalls.map((toolCall) => toolCall.id));
  state.toolCallEvents = state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId));
  state.toolCallRunLinks = state.toolCallRunLinks.filter((link) => toolCallIds.has(link.toolCallId));
  state.messageRunLinks = state.messageRunLinks.filter((link) => messageIds.has(link.messageId));
  state.messageLlmInvocationLinks = state.messageLlmInvocationLinks.filter((link) => messageIds.has(link.messageId));

  state.compressionBlocks = state.compressionBlocks.filter((block) => {
    if (block.conversationId !== timeline.conversationId) return true;
    const seq = block.anchorSeq ?? block.endSeq;
    return seq !== undefined && seqInConversationTimelineWindow(seq, window);
  });
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

  const patches = staleIds.map((id): ClientPatchOp => ({ kind: 'message.remove', id }));
  createClientStateDb(timeline.pageState).applyPatches(patches);
  pruneClientStateToTimelineWindow(timeline, timeline.pageState, false);
  createClientStateDb(timeline.state).applyPatches(patches);
}

function staleMessageIdsCoveredByStream(existingMessages: MessageRecord[], incomingMessages: MessageRecord[]): string[] {
  const incomingIds = new Set(incomingMessages.map((message) => message.id));
  const minIncomingSeq = Math.min(...incomingMessages.map((message) => message.seq));
  return existingMessages
    .filter((message) => message.seq >= minIncomingSeq && !incomingIds.has(message.id))
    .map((message) => message.id);
}

function loadedChunks(timeline: ConversationTimelineState): ConversationTimelineChunkSummaryRecord[] {
  return timeline.loadedChunkIds
    .map((id) => timeline.chunkById[id])
    .filter((chunk): chunk is ConversationTimelineChunkSummaryRecord => !!chunk)
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
}

function timelineHasOlder(timeline: ConversationTimelineState): boolean {
  const chunks = loadedChunks(timeline);
  return chunks.length > 0 ? timelineHasOlderChunks(chunks) : timeline.pageInfo?.hasOlder === true;
}

function timelineHasNewer(timeline: ConversationTimelineState): boolean {
  const chunks = loadedChunks(timeline);
  const totalChunks = knownTimelineTotalChunks(timeline);
  return chunks.length > 0
    ? timelineHasNewerChunks(chunks, totalChunks)
    : timeline.pageInfo?.hasNewer === true;
}

function knownTimelineTotalMessages(timeline: ConversationTimelineState): number {
  const pageInfo = timeline.pageInfo;
  const metadata = timeline.meta;
  if (!metadata) return pageInfo?.totalMessages ?? 0;
  if (!pageInfo || metadata.committedAt >= pageInfo.loadedAt) return metadata.totalMessages;
  return pageInfo.totalMessages;
}

function knownTimelineTotalChunks(timeline: ConversationTimelineState): number {
  const pageInfo = timeline.pageInfo;
  const metadata = timeline.meta;
  if (!metadata) return pageInfo?.totalChunks ?? 0;
  if (!pageInfo || metadata.committedAt >= pageInfo.loadedAt) return metadata.totalChunks;
  return pageInfo.totalChunks;
}

function trimAutomaticTailChunks(timeline: ConversationTimelineState): void {
  if (timeline.historyExpanded || !timeline.tailAttached) return;
  const chunks = loadedChunks(timeline);
  const removeCount = Math.max(0, chunks.length - MAX_TAIL_RESIDENT_CHUNKS);
  if (removeCount <= 0) return;
  for (const chunk of chunks.slice(0, removeCount)) delete timeline.chunkById[chunk.id];
  timeline.loadedChunkIds = loadedChunks(timeline).map((chunk) => chunk.id);
}

function didNewestChunkAdvance(
  previous: ConversationTimelineChunkSummaryRecord | undefined,
  next: ConversationTimelineChunkSummaryRecord | undefined
): boolean {
  if (!next) return false;
  if (!previous) return true;
  return next.index > previous.index
    || next.id !== previous.id
    || next.endSeq > previous.endSeq
    || next.messageCount > previous.messageCount;
}

function isTimelineLoading(status: ConversationTimelineStatus): boolean {
  return status === 'loadingInitial' || status === 'loadingOlder' || status === 'loadingNewer';
}

function directionForApplyMode(mode: ConversationTimelinePageRecord['applyMode']): ConversationTimelinePageDirection {
  if (mode === 'prepend') return 'older';
  if (mode === 'append') return 'newer';
  return 'initial';
}

function isGenericClientRemovePatch(patch: ClientPatchOp): boolean {
  return GENERIC_CLIENT_PATCH_APPLY_BY_KIND[patch.kind]?.operation === 'remove';
}

function mergeClientState(target: ClientState, source: ClientState): void {
  mergeClientStateTables(target, source, CLIENT_STATE_TABLE_KEYS);
}

function mergeClientStateTables(
  target: ClientState,
  source: ClientState,
  tableKeys: readonly ClientStateTableKey[]
): void {
  for (const key of tableKeys) {
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
  return cloneValue(record);
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  const chunks = loadedChunks(timeline);
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  return {
    ...incoming,
    chunkIds: chunks.map((chunk) => chunk.id),
    ...(first ? { startSeq: first.startSeq, oldestChunkId: first.id, previousCursor: first.id } : {}),
    ...(last ? { endSeq: last.endSeq, newestChunkId: last.id, nextCursor: last.id } : {}),
    hasOlder: chunks.length > 0 ? timelineHasOlderChunks(chunks) : incoming.hasOlder,
    hasNewer: chunks.length > 0 ? timelineHasNewerChunks(chunks, incoming.totalChunks) : incoming.hasNewer
  };
}

function mergePageInfoWithMeta(
  timeline: ConversationTimelineState,
  current: ConversationTimelinePageInfo | undefined,
  metadata: ConversationTimelineMetaRecord
): ConversationTimelinePageInfo {
  return mergePageInfo(timeline, {
    ...(current ?? createEmptyPageInfo(metadata.conversationId)),
    totalChunks: metadata.totalChunks,
    totalMessages: metadata.totalMessages,
    loadedAt: Math.max(current?.loadedAt ?? 0, metadata.committedAt)
  });
}

function oldestLoadedChunk(timeline: ConversationTimelineState): ConversationTimelineChunkSummaryRecord | undefined {
  return loadedChunks(timeline)[0];
}

function newestLoadedChunk(timeline: ConversationTimelineState): ConversationTimelineChunkSummaryRecord | undefined {
  return loadedChunks(timeline).sort((left, right) => right.index - left.index || right.id.localeCompare(left.id))[0];
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
