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
  type ConversationTimelinePageRequest,
  type ConversationTimelinePatchPayload,
  type LlmInvocationRecord,
  type MessageRecord
} from '@shared/protocol';
import type { TimelineProjectionContextRecord } from '@shared/timelineProjection';
import {
  conversationTimelineCommitCanApply,
  conversationTimelineStateForMessageIds,
  createConversationTimelineSeqWindow,
  pruneConversationTimelineStateToWindow,
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
  /** 已应用的 timeline+compression 统一提交序号。 */
  latestCommitSeq: number;
  /** 当前 pageState 对应的统一提交序号。 */
  pageCommitSeq: number;
  hasPageSnapshot: boolean;
  pendingPageRequestId?: string;
  pendingPageDirection?: ConversationTimelinePageDirection;
  failedPageRequest?: TimelinePageRequestDescriptor;
  initialRefreshPending: boolean;
  historyExpanded: boolean;
  tailAttached: boolean;
  tailCatchupPending: boolean;
  /** 每次 older 请求递增，用于把 prepend 锚点绑定到唯一请求。 */
  olderRequestRevision: number;
  /** 最近一次实际 prepend 成功的 older 请求序号。 */
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
  /** recent stream 窗口淘汰时保留的关系闭包，避免 page 未携带的 run/link 数据丢失。 */
  retainedState: ClientState;
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

interface TimelinePageRequestDescriptor {
  request: ConversationTimelinePageRequest;
  direction: ConversationTimelinePageDirection;
  requestRevision: number;
  staleRetryCount: number;
}

interface PendingClientStatePatchBatch {
  streamId: string;
  streamSeq: number;
  patches: ClientPatchOp[];
  windowEvictedMessageIds: string[];
  frameId?: number;
}

const pendingClientStatePatchBatches = new Map<string, PendingClientStatePatchBatch>();
const pendingTimelinePageRequests = new Map<string, TimelinePageRequestDescriptor>();
const MAX_STALE_PAGE_RETRIES = 2;

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
      return Math.max(
        this.currentTimeline.meta?.totalMessages ?? 0,
        this.currentTimeline.pageInfo?.totalMessages ?? 0,
        loadedMax
      );
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
    sendTimelinePageRequest(descriptor: TimelinePageRequestDescriptor): string {
      const request = plainTimelinePageRequest(descriptor.request);
      const normalized: TimelinePageRequestDescriptor = {
        request,
        direction: descriptor.direction,
        requestRevision: descriptor.requestRevision,
        staleRetryCount: descriptor.staleRetryCount
      };
      const requestId = bridge.request(
        BridgeMessageType.ConversationTimelinePageGet,
        request,
        { channel: 'state', scope: { kind: 'conversation', id: request.conversationId } }
      );
      pendingTimelinePageRequests.set(requestId, normalized);
      const timeline = this.ensureTimeline(request.conversationId);
      timeline.pendingPageRequestId = requestId;
      timeline.pendingPageDirection = normalized.direction;
      return requestId;
    },
    retryFailedPage(conversationId?: string): void {
      const targetConversationId = conversationId || this.currentConversationId;
      if (!targetConversationId) return;
      const timeline = this.ensureTimeline(targetConversationId);
      const failed = timeline.failedPageRequest;
      if (!failed || isTimelineLoading(timeline.status)) return;
      timeline.failedPageRequest = undefined;
      timeline.error = undefined;
      timeline.status = timelineStatusForDirection(failed.direction);
      this.sendTimelinePageRequest({ ...failed, staleRetryCount: 0 });
    },
    setPageRequestError(correlationId: string | undefined, conversationId: string | undefined, message: string): void {
      const pending = correlationId ? pendingTimelinePageRequests.get(correlationId) : undefined;
      if (correlationId) pendingTimelinePageRequests.delete(correlationId);
      const targetConversationId = pending?.request.conversationId ?? conversationId?.trim();
      if (!targetConversationId) return;
      const timeline = this.ensureTimeline(targetConversationId);
      if (correlationId && timeline.pendingPageRequestId && timeline.pendingPageRequestId !== correlationId) return;
      timeline.pendingPageRequestId = undefined;
      timeline.pendingPageDirection = undefined;
      timeline.initialRefreshPending = false;
      timeline.failedPageRequest = pending ?? initialPageRequestDescriptor(targetConversationId);
      timeline.status = 'error';
      timeline.error = message;
    },
    requestInitial(
      conversationId: string,
      chunkCount = DEFAULT_INITIAL_CHUNK_COUNT,
      options: { force?: boolean } = {}
    ): void {
      if (!conversationId) return;
      const timeline = this.ensureTimeline(conversationId);
      if (timeline.hasPageSnapshot && !options.force) {
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
      timeline.failedPageRequest = undefined;
      timeline.status = 'loadingInitial';
      timeline.error = undefined;
      this.sendTimelinePageRequest({
        request: { conversationId, direction: 'initial', chunkCount, includeProjections: TIMELINE_PROJECTIONS },
        direction: 'initial',
        requestRevision: 0,
        staleRetryCount: 0
      });
    },
    requestOlder(conversationId?: string): void {
      const targetConversationId = conversationId || this.currentConversationId;
      if (!targetConversationId) return;
      const timeline = this.ensureTimeline(targetConversationId);
      if (isTimelineLoading(timeline.status) || !timelineHasOlder(timeline)) return;
      const oldest = oldestLoadedChunk(timeline);
      timeline.historyExpanded = true;
      timeline.olderRequestRevision += 1;
      timeline.failedPageRequest = undefined;
      timeline.status = 'loadingOlder';
      timeline.error = undefined;
      this.sendTimelinePageRequest({
        request: {
          conversationId: targetConversationId,
          direction: 'older',
          cursor: oldest?.id,
          chunkCount: DEFAULT_INCREMENTAL_CHUNK_COUNT,
          includeProjections: TIMELINE_PROJECTIONS
        },
        direction: 'older',
        requestRevision: timeline.olderRequestRevision,
        staleRetryCount: 0
      });
    },
    requestNewer(conversationId?: string, options: { force?: boolean } = {}): void {
      const targetConversationId = conversationId || this.currentConversationId;
      if (!targetConversationId) return;
      const timeline = this.ensureTimeline(targetConversationId);
      if (isTimelineLoading(timeline.status)) return;
      if (!options.force && !timelineHasNewer(timeline)) return;
      const newest = newestLoadedChunk(timeline);
      if (!newest) return;
      timeline.failedPageRequest = undefined;
      timeline.status = 'loadingNewer';
      timeline.tailCatchupPending = false;
      timeline.error = undefined;
      this.sendTimelinePageRequest({
        request: {
          conversationId: targetConversationId,
          direction: 'newer',
          cursor: newest.id,
          chunkCount: DEFAULT_INCREMENTAL_CHUNK_COUNT,
          includeProjections: TIMELINE_PROJECTIONS
        },
        direction: 'newer',
        requestRevision: 0,
        staleRetryCount: 0
      });
    },
    requestAround(conversationId: string, messageId: string): void {
      if (!conversationId || !messageId) return;
      const timeline = this.ensureTimeline(conversationId);
      if (isTimelineLoading(timeline.status)) return;
      timeline.historyExpanded = true;
      timeline.failedPageRequest = undefined;
      timeline.status = 'loadingInitial';
      timeline.error = undefined;
      this.sendTimelinePageRequest({
        request: {
          conversationId,
          direction: 'around',
          anchorMessageId: messageId,
          chunkCount: DEFAULT_INCREMENTAL_CHUNK_COUNT,
          includeProjections: TIMELINE_PROJECTIONS
        },
        direction: 'around',
        requestRevision: 0,
        staleRetryCount: 0
      });
    },
    applyPageSnapshot(page: ConversationTimelinePageRecord, correlationId?: string): void {
      const pending = correlationId ? pendingTimelinePageRequests.get(correlationId) : undefined;
      if (correlationId) pendingTimelinePageRequests.delete(correlationId);
      const timeline = this.ensureTimeline(page.conversationId);
      if (correlationId && timeline.pendingPageRequestId && timeline.pendingPageRequestId !== correlationId) return;
      timeline.pendingPageRequestId = undefined;
      const direction = pending?.direction ?? timeline.pendingPageDirection ?? directionForApplyMode(page.applyMode);
      timeline.pendingPageDirection = undefined;

      if (!conversationTimelineCommitCanApply(page.commitSeq, timeline.latestCommitSeq)) {
        if (pending && pending.staleRetryCount < MAX_STALE_PAGE_RETRIES) {
          timeline.status = timelineStatusForDirection(direction);
          this.sendTimelinePageRequest({ ...pending, staleRetryCount: pending.staleRetryCount + 1 });
        } else {
          timeline.initialRefreshPending = false;
          timeline.failedPageRequest = pending ?? initialPageRequestDescriptor(page.conversationId);
          timeline.status = 'error';
          timeline.error = '对话消息在分页读取期间已更新，请重试加载。';
        }
        return;
      }

      timeline.latestCommitSeq = Math.max(timeline.latestCommitSeq, page.commitSeq);
      timeline.pageCommitSeq = page.commitSeq;
      timeline.failedPageRequest = undefined;
      const previousNewest = newestLoadedChunk(timeline);
      timeline.hasPageSnapshot = true;

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
      pruneClientStateToTimelineWindow(timeline, timeline.retainedState, timeline.tailAttached);

      // Page 只拥有已加载 chunk；stream 只作为覆盖层。prepend older 时绝不能
      // 根据持久化 hasNewer 把实时尾部从展示 state 中裁掉。
      if (timeline.hasStreamSnapshot) {
        removeStaleConversationStreamMessages(timeline, page.conversationId, timeline.streamState, {
          rawConversationMessageCount: timeline.streamState.messages.filter((message) => message.conversationId === page.conversationId).length,
          rawHasConversation: false
        });
      }
      rebuildTimelineState(timeline);
      timeline.projections = { ...timeline.projections, ...(page.projections ?? {}) };
      if (direction === 'older' && page.chunks.length > 0) {
        timeline.prependRevision = pending?.requestRevision ?? timeline.olderRequestRevision;
      }
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
      if (!conversationTimelineCommitCanApply(payload.commitSeq, timeline.latestCommitSeq)) return;
      timeline.latestCommitSeq = Math.max(timeline.latestCommitSeq, payload.commitSeq);

      // 这是 storage 成功提交后的权威 timeline patch。page/retained 两层都必须同步，
      // 否则已离开 recent stream 的 checkpoint/compression 删除会一直残留并在 merge 时复活。
      // streamState 仍由 ECS recent projection 独立负责；不能把 timeline sidecar remove 误解释成
      // ProjectContext/ShadowRepository 等共享领域对象的全局删除。
      createClientStateDb(timeline.pageState).applyPatches(payload.patches);
      createClientStateDb(timeline.retainedState).applyPatches(payload.patches);
      pruneClientStateToTimelineWindow(timeline, timeline.pageState, false);
      pruneClientStateToTimelineWindow(timeline, timeline.retainedState, timeline.tailAttached);
      rebuildTimelineState(timeline);
    },
    applyTimelineMeta(metadata: ConversationTimelineMetaRecord): void {
      const timeline = this.ensureTimeline(metadata.conversationId);
      if (!conversationTimelineCommitCanApply(metadata.commitSeq, timeline.latestCommitSeq)) return;
      timeline.latestCommitSeq = Math.max(timeline.latestCommitSeq, metadata.commitSeq);
      if (timeline.meta?.revision === metadata.revision && timeline.meta.commitSeq === metadata.commitSeq) return;
      if (timeline.meta && metadata.commitSeq === timeline.meta.commitSeq && metadata.committedAt < timeline.meta.committedAt) return;
      const previousTotalChunks = knownTimelineTotalChunks(timeline);
      const previousTotalMessages = knownTimelineTotalMessages(timeline);
      timeline.meta = cloneValue(metadata);
      if (timeline.hasPageSnapshot) {
        timeline.pageInfo = mergePageInfoWithMeta(timeline, timeline.pageInfo, metadata);
      }

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

      // stream snapshot 只精确覆盖最近窗口；窗口 floor 之前的 page/retained 记录不能按“快照缺失”删除。
      if (timeline.loadedChunkIds.length > 0) {
        removeStaleConversationStreamMessages(timeline, conversationId, timeline.streamState, {
          rawConversationMessageCount,
          rawHasConversation
        });
      }
      rebuildTimelineState(timeline);
      timeline.streamSeq = streamSeq;
      if (!timeline.hasPageSnapshot && !timeline.failedPageRequest && timeline.status !== 'loadingInitial') {
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
        rebuildTimelineState(timeline);
        timeline.streamSeq = batch.streamSeq;
        return;
      }

      const evictedMessageIds = new Set(batch.windowEvictedMessageIds);
      // 从固定 240 条的 previous stream window 提取，避免用户已展开大量历史后每条新消息都扫描完整页面状态。
      const evictedState = conversationTimelineStateForMessageIds(timeline.streamState, evictedMessageIds);
      createClientStateDb(timeline.streamState).applyPatches(patches);

      // pageState/retainedState 都接受真实删除；窗口淘汰关联的 remove 在应用后重新恢复。
      // page 只接收持久化表，stream 独有的 run/link 闭包进入 retained overlay。
      const removalPatches = patches.filter(isGenericClientRemovePatch);
      createClientStateDb(timeline.pageState).applyPatches(removalPatches);
      createClientStateDb(timeline.retainedState).applyPatches(removalPatches);
      mergeClientStateTables(timeline.pageState, evictedState, PAGE_OWNED_TABLE_KEYS);
      mergeClientState(timeline.retainedState, evictedState);
      pruneClientStateToTimelineWindow(timeline, timeline.pageState, false);
      pruneClientStateToTimelineWindow(timeline, timeline.retainedState, timeline.tailAttached);

      rebuildTimelineState(timeline);
      timeline.streamSeq = batch.streamSeq;
      this.maybeRequestTailCatchup(conversationId);
    },
    setError(conversationId: string | undefined, message: string): void {
      const target = conversationId ? this.ensureTimeline(conversationId) : this.currentTimeline;
      if (!isTimelineLoading(target.status)) {
        target.status = 'error';
        target.pendingPageDirection = undefined;
      }
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
    latestCommitSeq: 0,
    pageCommitSeq: 0,
    initialRefreshPending: false,
    historyExpanded: false,
    tailAttached: false,
    tailCatchupPending: false,
    olderRequestRevision: 0,
    prependRevision: 0,
    streamSeq: 0,
    hasPageSnapshot: false,
    hasStreamSnapshot: false,
    pageState: createEmptyClientState(),
    retainedState: createEmptyClientState(),
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
  pruneConversationTimelineStateToWindow(
    state,
    timeline.conversationId,
    loadedChunks(timeline),
    tailAttached
  );
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
  createClientStateDb(timeline.retainedState).applyPatches(patches);
  pruneClientStateToTimelineWindow(timeline, timeline.pageState, false);
  pruneClientStateToTimelineWindow(timeline, timeline.retainedState, timeline.tailAttached);
}

function rebuildTimelineState(timeline: ConversationTimelineState): void {
  const next = createEmptyClientState();
  mergeClientState(next, timeline.retainedState);
  mergeClientState(next, timeline.pageState);
  mergeClientState(next, timeline.streamState);
  pruneClientStateToTimelineWindow(timeline, next, timeline.tailAttached);
  timeline.state = next;
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
  if (!pageInfo || metadata.commitSeq >= timeline.pageCommitSeq) return metadata.totalMessages;
  return pageInfo.totalMessages;
}

function knownTimelineTotalChunks(timeline: ConversationTimelineState): number {
  const pageInfo = timeline.pageInfo;
  const metadata = timeline.meta;
  if (!metadata) return pageInfo?.totalChunks ?? 0;
  if (!pageInfo || metadata.commitSeq >= timeline.pageCommitSeq) return metadata.totalChunks;
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

function initialPageRequestDescriptor(conversationId: string): TimelinePageRequestDescriptor {
  return {
    request: {
      conversationId,
      direction: 'initial',
      chunkCount: DEFAULT_INITIAL_CHUNK_COUNT,
      includeProjections: [...TIMELINE_PROJECTIONS]
    },
    direction: 'initial',
    requestRevision: 0,
    staleRetryCount: 0
  };
}

function timelineStatusForDirection(direction: ConversationTimelinePageDirection): ConversationTimelineStatus {
  if (direction === 'older') return 'loadingOlder';
  if (direction === 'newer') return 'loadingNewer';
  return 'loadingInitial';
}

function plainTimelinePageRequest(request: ConversationTimelinePageRequest): ConversationTimelinePageRequest {
  return {
    conversationId: request.conversationId,
    ...(request.direction ? { direction: request.direction } : {}),
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(request.anchorMessageId ? { anchorMessageId: request.anchorMessageId } : {}),
    ...(request.chunkCount !== undefined ? { chunkCount: request.chunkCount } : {}),
    ...(request.includeProjections ? { includeProjections: [...request.includeProjections] } : {})
  };
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
