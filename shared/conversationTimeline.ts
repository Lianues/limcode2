import type { CheckpointRecord, CheckpointTimelineAnchorRecord, MessageRecord } from './protocol';

export interface ConversationMessageTimelineRow {
  kind: 'message';
  id: string;
  message: MessageRecord;
  messageFloorNumber: number;
}

export interface ConversationCheckpointTimelineRow {
  kind: 'checkpoint';
  id: string;
  checkpoint: CheckpointRecord;
  anchor: CheckpointTimelineAnchorRecord;
  floorMessageId: string;
  position: CheckpointTimelineAnchorRecord['position'];
  messageFloorNumber: number;
}

export type ConversationTimelineRow = ConversationMessageTimelineRow | ConversationCheckpointTimelineRow;

export interface BuildConversationTimelineRowsInput {
  messages: readonly MessageRecord[];
  checkpoints: readonly CheckpointRecord[];
  checkpointAnchors: readonly CheckpointTimelineAnchorRecord[];
}

export function buildConversationTimelineRows(input: BuildConversationTimelineRowsInput): ConversationTimelineRow[] {
  const checkpointsById = new Map(input.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const messages = [...input.messages].sort(compareMessages);
  const anchorsByMessage = groupAnchorsByFloorMessage(dedupeCheckpointAnchors(input.checkpointAnchors, checkpointsById, messages), checkpointsById);
  const rows: ConversationTimelineRow[] = [];

  messages.forEach((message, index) => {
    const messageFloorNumber = index + 1;
    const anchors = anchorsByMessage.get(message.id);
    appendCheckpointRows(rows, anchors?.before ?? [], checkpointsById, messageFloorNumber);
    rows.push({ kind: 'message', id: message.id, message, messageFloorNumber });
    appendCheckpointRows(rows, anchors?.after ?? [], checkpointsById, messageFloorNumber);
  });

  return rows;
}

function groupAnchorsByFloorMessage(
  anchors: readonly CheckpointTimelineAnchorRecord[],
  checkpointsById: ReadonlyMap<string, CheckpointRecord>
): Map<string, { before: CheckpointTimelineAnchorRecord[]; after: CheckpointTimelineAnchorRecord[] }> {
  const grouped = new Map<string, { before: CheckpointTimelineAnchorRecord[]; after: CheckpointTimelineAnchorRecord[] }>();
  for (const anchor of anchors) {
    if (!checkpointsById.has(anchor.checkpointId)) continue;
    const bucket = grouped.get(anchor.floorMessageId) ?? { before: [], after: [] };
    bucket[anchor.position].push(anchor);
    grouped.set(anchor.floorMessageId, bucket);
  }
  for (const bucket of grouped.values()) {
    bucket.before.sort(compareAnchors);
    bucket.after.sort(compareAnchors);
  }
  return grouped;
}

function dedupeCheckpointAnchors(
  anchors: readonly CheckpointTimelineAnchorRecord[],
  checkpointsById: ReadonlyMap<string, CheckpointRecord>,
  messages: readonly MessageRecord[]
): CheckpointTimelineAnchorRecord[] {
  const messageIndexById = new Map(messages.map((message, index) => [message.id, index]));
  const passthrough: CheckpointTimelineAnchorRecord[] = [];
  const anchorsByContentGap = new Map<number, CheckpointAnchorCandidate[]>();

  for (const anchor of anchors) {
    const checkpoint = checkpointsById.get(anchor.checkpointId);
    const contentGapIndex = timelineContentGapIndex(anchor, messageIndexById);
    if (!checkpoint || contentGapIndex === undefined) {
      passthrough.push(anchor);
      continue;
    }

    const bucket = anchorsByContentGap.get(contentGapIndex) ?? [];
    bucket.push({ anchor, checkpoint });
    anchorsByContentGap.set(contentGapIndex, bucket);
  }

  const result = [...passthrough];
  for (const bucket of anchorsByContentGap.values()) {
    result.push(...dedupeAdjacentNoChangeCheckpoints(bucket).map((item) => item.anchor));
  }
  return result;
}

interface CheckpointAnchorCandidate {
  anchor: CheckpointTimelineAnchorRecord;
  checkpoint: CheckpointRecord;
}

function timelineContentGapIndex(
  anchor: CheckpointTimelineAnchorRecord,
  messageIndexById: ReadonlyMap<string, number>
): number | undefined {
  const messageIndex = messageIndexById.get(anchor.floorMessageId);
  if (messageIndex === undefined) return undefined;
  // before 第 N 楼与 after 第 N-1 楼同属一个楼层间隙，才算相邻位置；
  // before/after 同一楼之间隔着消息楼层，不能为了去重跳楼层合并。
  return anchor.position === 'before' ? messageIndex : messageIndex + 1;
}

function dedupeAdjacentNoChangeCheckpoints(bucket: CheckpointAnchorCandidate[]): CheckpointAnchorCandidate[] {
  const sorted = [...bucket].sort(compareAnchorCandidatesInContentGap);
  const result: CheckpointAnchorCandidate[] = [];

  for (const candidate of sorted) {
    const previous = result[result.length - 1];
    if (previous && canMergeAdjacentCheckpoints(previous.checkpoint, candidate.checkpoint)) {
      result[result.length - 1] = preferredMergedCheckpointAnchor(previous, candidate);
      continue;
    }
    result.push(candidate);
  }

  return result;
}

function compareAnchorCandidatesInContentGap(left: CheckpointAnchorCandidate, right: CheckpointAnchorCandidate): number {
  const positionOrder = contentGapPositionOrder(left.anchor) - contentGapPositionOrder(right.anchor);
  return positionOrder || compareAnchors(left.anchor, right.anchor);
}

function contentGapPositionOrder(anchor: CheckpointTimelineAnchorRecord): number {
  return anchor.position === 'after' ? 0 : 1;
}

function canMergeAdjacentCheckpoints(previous: CheckpointRecord, next: CheckpointRecord): boolean {
  if (!isSameCheckpointTarget(previous, next)) return false;
  if (previous.status === 'failed') return false;
  // 相邻只表示候选；必须由后一条 checkpoint 明确确认项目内容没有变化，才去重合并。
  return next.status === 'skipped' && next.skipReason === 'no_changes';
}

function isSameCheckpointTarget(left: CheckpointRecord, right: CheckpointRecord): boolean {
  return left.conversationId === right.conversationId
    && left.projectContextId === right.projectContextId
    && left.shadowRepositoryId === right.shadowRepositoryId
    && left.projectUri === right.projectUri;
}

function preferredMergedCheckpointAnchor(
  previous: CheckpointAnchorCandidate,
  next: CheckpointAnchorCandidate
): CheckpointAnchorCandidate {
  // 如果其中一条是真正创建的存档点，保留可回档的实际快照；
  // 都是 no_changes 时保留较新的展示位置，避免重复提示。
  if (previous.checkpoint.status === 'created') return previous;
  if (next.checkpoint.status === 'created') return next;
  return compareAnchors(previous.anchor, next.anchor) <= 0 ? next : previous;
}

function appendCheckpointRows(
  rows: ConversationTimelineRow[],
  anchors: readonly CheckpointTimelineAnchorRecord[],
  checkpointsById: ReadonlyMap<string, CheckpointRecord>,
  messageFloorNumber: number
): void {
  for (const anchor of anchors) {
    const checkpoint = checkpointsById.get(anchor.checkpointId);
    if (!checkpoint) continue;
    rows.push({
      kind: 'checkpoint',
      id: `checkpoint:${anchor.id}`,
      checkpoint,
      anchor,
      floorMessageId: anchor.floorMessageId,
      position: anchor.position,
      messageFloorNumber
    });
  }
}

function compareMessages(left: MessageRecord, right: MessageRecord): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function compareAnchors(left: CheckpointTimelineAnchorRecord, right: CheckpointTimelineAnchorRecord): number {
  return left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}
