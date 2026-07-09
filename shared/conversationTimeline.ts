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
  anchorMessages?: readonly MessageRecord[];
  checkpoints: readonly CheckpointRecord[];
  checkpointAnchors: readonly CheckpointTimelineAnchorRecord[];
  compressionBlocks?: readonly CompressionBlockRecord[];
}

export function buildConversationTimelineRows(input: BuildConversationTimelineRowsInput): ConversationTimelineRow[] {
  const checkpointsById = new Map(input.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const anchoredCheckpointIds = new Set(input.checkpointAnchors.map((anchor) => anchor.checkpointId));
  const messages = [...input.messages].sort(compareMessages);
  const anchorMessages = [...(input.anchorMessages ?? input.messages)].sort(compareMessages);
  const anchorsByMessage = groupAnchorsByFloorMessage(input.checkpointAnchors, checkpointsById);
  const compressionRows = groupCompressionByDisplayAnchor(input.compressionBlocks ?? [], messages, anchorMessages);
  const rows: ConversationTimelineRow[] = [];
  appendInitialCheckpointRows(rows, input.checkpoints, anchoredCheckpointIds);

  messages.forEach((message, index) => {
    const messageFloorNumber = index + 1;
    const anchors = anchorsByMessage.get(message.id);
    appendCheckpointRows(rows, anchors?.before ?? [], checkpointsById, messageFloorNumber);
    rows.push({ kind: 'message', id: message.id, message, messageFloorNumber });
    appendCompressionRows(rows, compressionRows.byMessage.get(message.id) ?? [], messageFloorNumber, message.id);
    appendCheckpointRows(rows, anchors?.after ?? [], checkpointsById, messageFloorNumber);
  });

  return rows;
}

function groupCompressionByDisplayAnchor(
  blocks: readonly CompressionBlockRecord[],
  messages: readonly MessageRecord[],
  anchorMessages: readonly MessageRecord[]
): { byMessage: Map<string, CompressionBlockRecord[]> } {
  const byMessage = new Map<string, CompressionBlockRecord[]>();
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const anchorMessageById = new Map(anchorMessages.map((message) => [message.id, message]));
  // 压缩块只展示在当前已加载 timeline 范围内。隐藏的 functionResponse / backfill 消息
  // 可作为后端压缩锚点，但前端不直接渲染它们；此时把压缩卡片折叠挂到“锚点之前最近的可见消息”后面。
  // 这样长对话或工具结果结尾时，running 压缩块不会只让按钮变成“压缩中”却没有占位卡片。
  const firstLoadedSeq = anchorMessages[0]?.seq ?? messages[0]?.seq;
  const lastLoadedSeq = anchorMessages[anchorMessages.length - 1]?.seq ?? messages[messages.length - 1]?.seq;
  for (const block of blocks) {
    const anchorId = displayAnchorMessageId(block, messages, messageById, anchorMessageById, firstLoadedSeq, lastLoadedSeq);
    if (!anchorId) continue;
    const list = byMessage.get(anchorId) ?? [];
    list.push(block);
    byMessage.set(anchorId, list);
  }
  for (const list of byMessage.values()) list.sort(compareCompressionBlocks);
  return { byMessage };
}

function displayAnchorMessageId(
  block: CompressionBlockRecord,
  messages: readonly MessageRecord[],
  messageById: ReadonlyMap<string, MessageRecord>,
  anchorMessageById: ReadonlyMap<string, MessageRecord>,
  firstLoadedSeq: number | undefined,
  lastLoadedSeq: number | undefined
): string | undefined {
  if (block.anchorMessageId && messageById.has(block.anchorMessageId)) return block.anchorMessageId;
  const hiddenAnchorSeq = block.anchorMessageId ? anchorMessageById.get(block.anchorMessageId)?.seq : undefined;
  const anchorSeq = hiddenAnchorSeq ?? block.anchorSeq ?? block.endSeq;
  if (anchorSeq === undefined || firstLoadedSeq === undefined || lastLoadedSeq === undefined) return undefined;
  if (anchorSeq < firstLoadedSeq || anchorSeq > lastLoadedSeq) return undefined;
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

function compareCompressionBlocks(left: CompressionBlockRecord, right: CompressionBlockRecord): number {
  return (left.anchorSeq ?? left.endSeq ?? 0) - (right.anchorSeq ?? right.endSeq ?? 0) || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function compareAnchors(left: CheckpointTimelineAnchorRecord, right: CheckpointTimelineAnchorRecord): number {
  return left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}
