import type {
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
  ToolCallEventRecord,
  ToolCallRecord
} from '../../../../shared/protocol';
import type { TimelineProjectionKey } from '../../../../shared/timelineProjection';

export interface ConversationTimelineChunkData {
  messages: MessageRecord[];
  messageRevisions: MessageRevisionRecord[];
  messageCurrentRevisionLinks: MessageCurrentRevisionLinkRecord[];
  toolCalls: ToolCallRecord[];
  toolCallEvents: ToolCallEventRecord[];
}

export interface TimelineProjectionReduceInput<TSnapshot> {
  conversationId: string;
  chunkId: string;
  chunk: ConversationTimelineChunkData;
  previousSnapshot: TSnapshot;
  operationStartIndex: number;
}

export interface TimelineProjectionReduceResult<TSnapshot> {
  snapshotAfterChunk: TSnapshot;
  operationCount?: number;
  operationEndIndex: number;
}

export interface TimelineProjectionSpec<TSnapshot = unknown> {
  key: TimelineProjectionKey;
  emptySnapshot(): TSnapshot;
  reduceChunk(input: TimelineProjectionReduceInput<TSnapshot>): TimelineProjectionReduceResult<TSnapshot>;
}
