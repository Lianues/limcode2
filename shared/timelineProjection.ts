export type TimelineProjectionKey = string;

export interface TimelineProjectionRefRecord {
  file: string;
  checkpointHash: string;
  previousCheckpointHash?: string;
  operationCount?: number;
}

export interface TimelineProjectionCheckpointRecord<TSnapshot = unknown> {
  schemaVersion: number;
  savedAt: string;
  conversationId: string;
  chunkId: string;
  projectionKey: TimelineProjectionKey;
  startSeq: number;
  endSeq: number;
  snapshotAfterChunk: TSnapshot;
  operationCount?: number;
  sourceHash: string;
  checkpointHash: string;
  previousCheckpointHash?: string;
}

export interface TimelineProjectionContextRecord<TSnapshot = unknown> {
  conversationId: string;
  /** 当前分页起始 chunk，用于解释 snapshotBeforeChunk / snapshotAfterChunk。 */
  chunkId: string;
  currentChunkStartSeq: number;
  currentChunkEndSeq: number;
  /** 当前持久化时间线中的最新 chunk，用于把实时尾部增量叠加到 latestSnapshot 后。 */
  latestChunkId: string;
  latestChunkStartSeq: number;
  latestChunkEndSeq: number;
  projectionKey: TimelineProjectionKey;
  snapshotBeforeChunk: TSnapshot;
  snapshotAfterChunk: TSnapshot;
  latestSnapshot: TSnapshot;
}
