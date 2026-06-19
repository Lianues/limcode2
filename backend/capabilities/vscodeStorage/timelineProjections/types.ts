import type {
  CheckpointRecord,
  CheckpointTimelineAnchorRecord,
  ConversationCheckpointRepositoryLinkRecord,
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
  ProjectContextRecord,
  ShadowRepositoryRecord,
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
  projectContexts: ProjectContextRecord[];
  shadowRepositories: ShadowRepositoryRecord[];
  conversationCheckpointRepositoryLinks: ConversationCheckpointRepositoryLinkRecord[];
  checkpoints: CheckpointRecord[];
  checkpointTimelineAnchors: CheckpointTimelineAnchorRecord[];
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
