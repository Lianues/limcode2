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
      return this.currentTimeline.state.messages
        .filter((message) => message.conversationId === this.currentConversationId)
        .filter((message) => !message.content.parts.some((part) => 'functionResponse' in part))
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
    },
    applyClientStateSnapshot(streamId: string, streamSeq: number, state: ClientState): void {
      const conversationId = conversationIdFromClientStateStreamId(streamId);
      if (!conversationId) return;
      const timeline = this.ensureTimeline(conversationId);
      if (state.messages.some((message) => message.conversationId === conversationId)) {
        timeline.state = createEmptyClientState();
        timeline.loadedChunkIds = [];
        timeline.chunkById = {};
      }
      mergeClientState(timeline.state, state);
      timeline.streamSeq = streamSeq;
    },
    applyClientStatePatch(streamId: string, streamSeq: number, patches: ClientPatchOp[]): void {
      const conversationId = conversationIdFromClientStateStreamId(streamId);
      if (!conversationId) return;
      this.applyTimelinePatch({ conversationId, streamSeq, patches });
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

function createTimelineState(conversationId: string): ConversationTimelineState {
  return {
    conversationId,
    status: 'idle',
    loadedChunkIds: [],
    chunkById: {},
    streamSeq: 0,
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
  if (typeof structuredClone === 'function') return structuredClone(record);
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
