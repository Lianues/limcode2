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
  chunkId: string;
  projectionKey: TimelineProjectionKey;
  snapshotBeforeChunk: TSnapshot;
  snapshotAfterChunk: TSnapshot;
  latestSnapshot: TSnapshot;
}
