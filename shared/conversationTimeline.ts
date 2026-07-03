import type { CheckpointRecord, CheckpointTimelineAnchorRecord, CompressionBlockRecord, MessageRecord } from './protocol';

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

export interface ConversationCompressionTimelineRow {
  kind: 'compression';
  id: string;
  block: CompressionBlockRecord;
  floorMessageId?: string;
  messageFloorNumber?: number;
}

export type ConversationTimelineRow = ConversationMessageTimelineRow | ConversationCheckpointTimelineRow | ConversationCompressionTimelineRow;

export interface BuildConversationTimelineRowsInput {
  messages: readonly MessageRecord[];
  checkpoints: readonly CheckpointRecord[];
  checkpointAnchors: readonly CheckpointTimelineAnchorRecord[];
  compressionBlocks?: readonly CompressionBlockRecord[];
}

export function buildConversationTimelineRows(input: BuildConversationTimelineRowsInput): ConversationTimelineRow[] {
  const checkpointsById = new Map(input.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const anchoredCheckpointIds = new Set(input.checkpointAnchors.map((anchor) => anchor.checkpointId));
  const messages = [...input.messages].sort(compareMessages);
  const anchorsByMessage = groupAnchorsByFloorMessage(input.checkpointAnchors, checkpointsById);
  const compressionByMessage = groupCompressionByDisplayAnchor(input.compressionBlocks ?? [], messages);
  const rows: ConversationTimelineRow[] = [];
  appendInitialCheckpointRows(rows, input.checkpoints, anchoredCheckpointIds);

  messages.forEach((message, index) => {
    const messageFloorNumber = index + 1;
    const anchors = anchorsByMessage.get(message.id);
    appendCheckpointRows(rows, anchors?.before ?? [], checkpointsById, messageFloorNumber);
    rows.push({ kind: 'message', id: message.id, message, messageFloorNumber });
    appendCompressionRows(rows, compressionByMessage.get(message.id) ?? [], messageFloorNumber, message.id);
    appendCheckpointRows(rows, anchors?.after ?? [], checkpointsById, messageFloorNumber);
  });

  return rows;
}

function groupCompressionByDisplayAnchor(
  blocks: readonly CompressionBlockRecord[],
  messages: readonly MessageRecord[]
): Map<string, CompressionBlockRecord[]> {
  const grouped = new Map<string, CompressionBlockRecord[]>();
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const firstSeq = messages[0]?.seq;
  const lastSeq = messages[messages.length - 1]?.seq;
  for (const block of blocks) {
    const anchorId = displayAnchorMessageId(block, messages, messageById, firstSeq, lastSeq);
    if (!anchorId) continue;
    const list = grouped.get(anchorId) ?? [];
    list.push(block);
    grouped.set(anchorId, list);
  }
  for (const list of grouped.values()) list.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  return grouped;
}

function displayAnchorMessageId(
  block: CompressionBlockRecord,
  messages: readonly MessageRecord[],
  messageById: ReadonlyMap<string, MessageRecord>,
  firstSeq: number | undefined,
  lastSeq: number | undefined
): string | undefined {
  if (block.anchorMessageId && messageById.has(block.anchorMessageId)) return block.anchorMessageId;
  const anchorSeq = block.anchorSeq ?? block.endSeq;
  if (anchorSeq === undefined || firstSeq === undefined || lastSeq === undefined) return undefined;
  if (anchorSeq < firstSeq || anchorSeq > lastSeq) return undefined;
  let fallback: MessageRecord | undefined;
  for (const message of messages) {
    if (message.seq > anchorSeq) break;
    fallback = message;
  }
  return fallback?.id;
}

function appendCompressionRows(rows: ConversationTimelineRow[], blocks: readonly CompressionBlockRecord[], messageFloorNumber: number, floorMessageId: string): void {
  for (const block of blocks) {
    rows.push({ kind: 'compression', id: `compression:${block.id}`, block, floorMessageId, messageFloorNumber });
  }
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
