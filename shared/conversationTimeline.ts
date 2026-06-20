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
  anchor?: CheckpointTimelineAnchorRecord;
  floorMessageId?: string;
  position?: CheckpointTimelineAnchorRecord['position'] | 'start';
  messageFloorNumber?: number;
}

export type ConversationTimelineRow = ConversationMessageTimelineRow | ConversationCheckpointTimelineRow;

export interface BuildConversationTimelineRowsInput {
  messages: readonly MessageRecord[];
  checkpoints: readonly CheckpointRecord[];
  checkpointAnchors: readonly CheckpointTimelineAnchorRecord[];
}

export function buildConversationTimelineRows(input: BuildConversationTimelineRowsInput): ConversationTimelineRow[] {
  const checkpointsById = new Map(input.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const anchoredCheckpointIds = new Set(input.checkpointAnchors.map((anchor) => anchor.checkpointId));
  const messages = [...input.messages].sort(compareMessages);
  const anchorsByMessage = groupAnchorsByFloorMessage(input.checkpointAnchors, checkpointsById);
  const rows: ConversationTimelineRow[] = [];
  appendInitialCheckpointRows(rows, input.checkpoints, anchoredCheckpointIds);

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

function appendInitialCheckpointRows(
  rows: ConversationTimelineRow[],
  checkpoints: readonly CheckpointRecord[],
  anchoredCheckpointIds: ReadonlySet<string>
): void {
  const initialCheckpoints = checkpoints
    .filter((checkpoint) => checkpoint.trigger === 'conversation_initial' && !anchoredCheckpointIds.has(checkpoint.id))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  for (const checkpoint of initialCheckpoints) {
    rows.push({
      kind: 'checkpoint',
      id: `checkpoint:initial:${checkpoint.id}`,
      checkpoint,
      position: 'start'
    });
  }
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
