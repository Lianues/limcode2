import * as vscode from 'vscode';
import type {
  CheckpointRecord,
  CheckpointTimelineAnchorRecord,
  ConversationCheckpointRepositoryLinkRecord,
  ConversationTimelineChunkSummaryRecord,
  ConversationTimelinePageRecord,
  ConversationTimelinePageRequest,
  ClientState,
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
  ProjectContextRecord,
  ShadowRepositoryRecord,
  ToolCallEventRecord,
  ToolCallRecord
} from '../../../shared/protocol';
import { createEmptyClientState } from '../../../shared/clientStateSchema';
import type { TimelineProjectionContextRecord, TimelineProjectionRefRecord } from '../../../shared/timelineProjection';
import { INDEX_FILE, STORAGE_VERSION } from './constants';
import { createVscodeStoragePaths } from './paths';
import { readJson, writeJson } from './json';
import { BUILTIN_TIMELINE_PROJECTIONS, type ConversationTimelineChunkData, type TimelineProjectionSpec } from './timelineProjections';

export type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;

type TimelineSidecarKey =
  | 'message-revisions'
  | 'message-current-revision-links'
  | 'tool-calls'
  | 'tool-call-events'
  | 'project-contexts'
  | 'shadow-repositories'
  | 'conversation-checkpoint-repository-links'
  | 'checkpoints'
  | 'checkpoint-timeline-anchors';

interface ConversationTimelineIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversationId: string;
  chunkSize: number;
  chunks: ConversationTimelineChunkIndexRecord[];
}

interface ConversationTimelineChunkIndexRecord {
  id: string;
  file: string;
  index: number;
  startSeq: number;
  endSeq: number;
  messageCount: number;
  messageOffsetStart: number;
  messageOffsetEnd: number;
  messageIds: string[];
  toolCallIds: string[];
  toolCallCount: number;
  toolCallEventCount: number;
  /** 只校验 chunks/{chunkId}.json 内的 messages。 */
  messageHash: string;
  /** 校验 messages + sidecars 的完整投影输入，用于 projection checkpoint。 */
  sourceHash: string;
  sidecars: Record<TimelineSidecarKey, TimelineSidecarRefRecord>;
  projections: Record<string, TimelineProjectionRefRecord>;
}

interface TimelineSidecarRefRecord {
  file: string;
  sourceHash: string;
  count: number;
}

interface ConversationTimelineChunkFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversationId: string;
  chunkId: string;
  startSeq: number;
  endSeq: number;
  messageHash: string;
  messages: MessageRecord[];
}

interface ConversationTimelineSidecarFile<TRecord = unknown> {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversationId: string;
  chunkId: string;
  sidecarKey: TimelineSidecarKey;
  sourceHash: string;
  count: number;
  records: TRecord[];
}

interface TimelineProjectionCheckpointFile<TSnapshot = unknown> {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversationId: string;
  chunkId: string;
  projectionKey: string;
  startSeq: number;
  endSeq: number;
  snapshotAfterChunk: TSnapshot;
  operationCount?: number;
  sourceHash: string;
  checkpointHash: string;
  previousCheckpointHash?: string;
}

const CONVERSATION_DETAILS_DIR = 'details';
const CONVERSATION_MESSAGES_DIR = 'messages';
const CONVERSATION_TIMELINE_CHUNKS_DIR = 'chunks';
const CONVERSATION_TIMELINE_SIDECARS_DIR = 'sidecars';
const CONVERSATION_TIMELINE_PROJECTIONS_DIR = 'projections';
const CONVERSATION_TIMELINE_CHUNK_SIZE = 100;
const TIMELINE_LOAD_BATCH_SIZE = 32;

const TIMELINE_SIDECAR_KEYS: readonly TimelineSidecarKey[] = [
  'message-revisions',
  'message-current-revision-links',
  'tool-calls',
  'tool-call-events',
  'project-contexts',
  'shadow-repositories',
  'conversation-checkpoint-repository-links',
  'checkpoints',
  'checkpoint-timeline-anchors'
] as const;

export async function loadConversationTimelineDetail(paths: StoragePaths, conversationId: string): Promise<ClientState | undefined> {
  const root = conversationTimelineRoot(paths, conversationId);
  const index = await readJson<ConversationTimelineIndexFile>(vscode.Uri.joinPath(root, INDEX_FILE));
  if (!isConversationTimelineIndex(index, conversationId)) return undefined;

  const state = createEmptyClientState();
  for (let chunkIndex = 0; chunkIndex < index.chunks.length; chunkIndex += TIMELINE_LOAD_BATCH_SIZE) {
    const chunkFiles = await Promise.all(index.chunks.slice(chunkIndex, chunkIndex + TIMELINE_LOAD_BATCH_SIZE).map((chunk) => readConversationTimelineChunk(root, chunk)));
    for (const chunk of chunkFiles) {
      if (!chunk) continue;
      state.messages.push(...chunk.messages);
      state.messageRevisions.push(...chunk.messageRevisions);
      state.messageCurrentRevisionLinks.push(...chunk.messageCurrentRevisionLinks);
      state.toolCalls.push(...chunk.toolCalls);
      state.toolCallEvents.push(...chunk.toolCallEvents);
      state.projectContexts.push(...chunk.projectContexts);
      state.shadowRepositories.push(...chunk.shadowRepositories);
      state.conversationCheckpointRepositoryLinks.push(...chunk.conversationCheckpointRepositoryLinks);
      state.checkpoints.push(...chunk.checkpoints);
      state.checkpointTimelineAnchors.push(...chunk.checkpointTimelineAnchors);
    }
    if (chunkIndex + TIMELINE_LOAD_BATCH_SIZE < index.chunks.length) {
      await yieldToExtensionHost();
    }
  }
  sortConversationTimelineDetail(state);
  return state;
}

const DEFAULT_TIMELINE_PAGE_CHUNKS = 2;
const MAX_TIMELINE_PAGE_CHUNKS = 5;

export async function loadConversationTimelinePage(paths: StoragePaths, request: ConversationTimelinePageRequest): Promise<ConversationTimelinePageRecord> {
  const root = conversationTimelineRoot(paths, request.conversationId);
  const index = await readJson<ConversationTimelineIndexFile>(vscode.Uri.joinPath(root, INDEX_FILE));
  if (!isConversationTimelineIndex(index, request.conversationId) || index.chunks.length === 0) {
    return emptyTimelinePage(request.conversationId, applyModeForDirection(request.direction));
  }

  const chunks = await normalizeTimelineChunkIndexRecords(root, index.chunks);
  const selected = selectTimelinePageChunks(chunks, request);
  const state = createEmptyClientState();
  const chunkFiles = await Promise.all(selected.map((chunk) => readConversationTimelineChunk(root, chunk)));
  for (const chunk of chunkFiles) {
    if (!chunk) continue;
    state.messages.push(...chunk.messages);
    state.messageRevisions.push(...chunk.messageRevisions);
    state.messageCurrentRevisionLinks.push(...chunk.messageCurrentRevisionLinks);
    state.toolCalls.push(...chunk.toolCalls);
    state.toolCallEvents.push(...chunk.toolCallEvents);
    state.projectContexts.push(...chunk.projectContexts);
    state.shadowRepositories.push(...chunk.shadowRepositories);
    state.conversationCheckpointRepositoryLinks.push(...chunk.conversationCheckpointRepositoryLinks);
    state.checkpoints.push(...chunk.checkpoints);
    state.checkpointTimelineAnchors.push(...chunk.checkpointTimelineAnchors);
  }
  sortConversationTimelineDetail(state);

  const projections: Record<string, TimelineProjectionContextRecord> = {};
  const projectionChunk = selected[0];
  for (const projectionKey of request.includeProjections ?? []) {
    if (!projectionChunk) continue;
    const context = await loadTimelineProjectionContext(paths, request.conversationId, projectionKey, projectionChunk.id);
    if (context) projections[projectionKey] = context;
  }

  return {
    conversationId: request.conversationId,
    applyMode: applyModeForDirection(request.direction),
    chunks: selected.map(chunkSummary),
    pageInfo: timelinePageInfo(request.conversationId, chunks, selected),
    state,
    ...(Object.keys(projections).length > 0 ? { projections } : {})
  };
}

export async function loadConversationLatestMessages(paths: StoragePaths, conversationId: string, limit = 50): Promise<MessageRecord[]> {
  const page = await loadConversationTimelinePage(paths, {
    conversationId,
    direction: 'initial',
    chunkCount: Math.max(1, Math.ceil(Math.max(1, limit) / CONVERSATION_TIMELINE_CHUNK_SIZE))
  });
  return page.state.messages.sort(compareMessagesBySeq).slice(-Math.max(1, limit));
}

export async function loadConversationMessagesByIds(paths: StoragePaths, conversationId: string, messageIds: readonly string[]): Promise<MessageRecord[]> {
  const wanted = new Set(messageIds);
  if (wanted.size === 0) return [];
  const root = conversationTimelineRoot(paths, conversationId);
  const index = await readJson<ConversationTimelineIndexFile>(vscode.Uri.joinPath(root, INDEX_FILE));
  if (!isConversationTimelineIndex(index, conversationId)) return [];
  const allRecords = await normalizeTimelineChunkIndexRecords(root, index.chunks);
  const records = allRecords.filter((chunk) => chunk.messageIds.some((id) => wanted.has(id)));
  const chunks = await Promise.all(records.map((chunk) => readConversationTimelineChunk(root, chunk)));
  return chunks
    .flatMap((chunk) => chunk?.messages ?? [])
    .filter((message) => wanted.has(message.id))
    .sort(compareMessagesBySeq);
}
export async function loadConversationTimelineRange(paths: StoragePaths, request: {
  conversationId: string;
  mode: 'suffix' | 'prefix' | 'between';
  anchorMessageId?: string;
  startMessageId?: string;
  endMessageId?: string;
  contextBeforeChunks?: number;
}): Promise<ClientState | undefined> {
  const root = conversationTimelineRoot(paths, request.conversationId);
  const index = await readJson<ConversationTimelineIndexFile>(vscode.Uri.joinPath(root, INDEX_FILE));
  if (!isConversationTimelineIndex(index, request.conversationId) || index.chunks.length === 0) return undefined;
  const chunks = await normalizeTimelineChunkIndexRecords(root, index.chunks);
  const selected = selectTimelineRangeChunks(chunks, request);
  if (selected.length === 0) return undefined;
  const state = createEmptyClientState();
  const chunkFiles = await Promise.all(selected.map((chunk) => readConversationTimelineChunk(root, chunk)));
  for (const chunk of chunkFiles) {
    if (!chunk) continue;
    state.messages.push(...chunk.messages);
    state.messageRevisions.push(...chunk.messageRevisions);
    state.messageCurrentRevisionLinks.push(...chunk.messageCurrentRevisionLinks);
    state.toolCalls.push(...chunk.toolCalls);
    state.toolCallEvents.push(...chunk.toolCallEvents);
    state.projectContexts.push(...chunk.projectContexts);
    state.shadowRepositories.push(...chunk.shadowRepositories);
    state.conversationCheckpointRepositoryLinks.push(...chunk.conversationCheckpointRepositoryLinks);
    state.checkpoints.push(...chunk.checkpoints);
    state.checkpointTimelineAnchors.push(...chunk.checkpointTimelineAnchors);
  }
  sortConversationTimelineDetail(state);
  return state;
}

function selectTimelineRangeChunks(
  chunks: ConversationTimelineChunkIndexRecord[],
  request: { mode: 'suffix' | 'prefix' | 'between'; anchorMessageId?: string; startMessageId?: string; endMessageId?: string; contextBeforeChunks?: number }
): ConversationTimelineChunkIndexRecord[] {
  const anchorId = request.anchorMessageId ?? request.startMessageId ?? request.endMessageId;
  const anchorIndex = anchorId ? chunks.findIndex((chunk) => chunk.messageIds.includes(anchorId)) : -1;
  const before = Math.max(0, Math.floor(request.contextBeforeChunks ?? 0));
  if (request.mode === 'suffix') {
    if (anchorIndex < 0) return [];
    return chunks.slice(Math.max(0, anchorIndex - before));
  }
  if (request.mode === 'prefix') {
    if (anchorIndex < 0) return chunks;
    return chunks.slice(0, anchorIndex + 1);
  }
  const startIndex = request.startMessageId ? chunks.findIndex((chunk) => chunk.messageIds.includes(request.startMessageId!)) : 0;
  const endIndex = request.endMessageId ? chunks.findIndex((chunk) => chunk.messageIds.includes(request.endMessageId!)) : chunks.length - 1;
  if (startIndex < 0 || endIndex < 0) return [];
  return chunks.slice(Math.max(0, startIndex - before), Math.max(startIndex, endIndex) + 1);
}



function selectTimelinePageChunks(
  chunks: ConversationTimelineChunkIndexRecord[],
  request: ConversationTimelinePageRequest
): ConversationTimelineChunkIndexRecord[] {
  const total = chunks.length;
  const count = normalizeTimelinePageChunkCount(request.chunkCount);
  const direction = request.direction ?? 'initial';
  if (direction === 'initial') return chunks.slice(Math.max(0, total - count));

  const cursorIndex = request.anchorMessageId
    ? chunks.findIndex((chunk) => chunk.messageIds.includes(request.anchorMessageId!))
    : request.cursor ? chunks.findIndex((chunk) => chunk.id === request.cursor || String(chunk.index) === request.cursor) : -1;

  if (direction === 'older') {
    const end = cursorIndex >= 0 ? cursorIndex : 0;
    return chunks.slice(Math.max(0, end - count), end);
  }
  if (direction === 'newer') {
    const start = cursorIndex >= 0 ? cursorIndex + 1 : Math.max(0, total - count);
    return chunks.slice(start, Math.min(total, start + count));
  }

  const center = cursorIndex >= 0 ? cursorIndex : Math.max(0, total - 1);
  const before = Math.floor((count - 1) / 2);
  const start = Math.max(0, center - before);
  return chunks.slice(start, Math.min(total, start + count));
}

function normalizeTimelinePageChunkCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMELINE_PAGE_CHUNKS;
  return Math.max(1, Math.min(MAX_TIMELINE_PAGE_CHUNKS, Math.floor(value!)));
}

async function normalizeTimelineChunkIndexRecords(root: vscode.Uri, records: ConversationTimelineChunkIndexRecord[]): Promise<ConversationTimelineChunkIndexRecord[]> {
  const normalized: ConversationTimelineChunkIndexRecord[] = [];
  let messageOffset = 0;
  for (let position = 0; position < records.length; position += 1) {
    const record = records[position] as ConversationTimelineChunkIndexRecord & Partial<{
      index: number;
      startSeq: number;
      endSeq: number;
      messageCount: number;
      messageOffsetStart: number;
      messageOffsetEnd: number;
      messageIds: string[];
      toolCallIds: string[];
      toolCallCount: number;
      toolCallEventCount: number;
    }>;
    const needsChunkFile = typeof record.startSeq !== 'number'
      || typeof record.endSeq !== 'number'
      || typeof record.messageCount !== 'number'
      || !Array.isArray(record.messageIds);
    const file = needsChunkFile
      ? await readJson<ConversationTimelineChunkFile>(vscode.Uri.joinPath(root, ...record.file.split('/')))
      : undefined;
    const messages = file?.schemaVersion === STORAGE_VERSION && file.chunkId === record.id ? file.messages : [];
    const messageCount = typeof record.messageCount === 'number' ? record.messageCount : messages.length;
    const messageOffsetStart = typeof record.messageOffsetStart === 'number' ? record.messageOffsetStart : messageOffset + 1;
    const messageOffsetEnd = typeof record.messageOffsetEnd === 'number' ? record.messageOffsetEnd : messageOffset + messageCount;
    normalized.push({
      ...record,
      index: typeof record.index === 'number' ? record.index : position,
      startSeq: typeof record.startSeq === 'number' ? record.startSeq : messages[0]?.seq ?? 0,
      endSeq: typeof record.endSeq === 'number' ? record.endSeq : messages[messages.length - 1]?.seq ?? 0,
      messageCount,
      messageOffsetStart,
      messageOffsetEnd,
      messageIds: Array.isArray(record.messageIds) ? record.messageIds : messages.map((message) => message.id),
      toolCallIds: Array.isArray(record.toolCallIds) ? record.toolCallIds : [],
      toolCallCount: typeof record.toolCallCount === 'number' ? record.toolCallCount : Array.isArray(record.toolCallIds) ? record.toolCallIds.length : 0,
      toolCallEventCount: typeof record.toolCallEventCount === 'number' ? record.toolCallEventCount : 0
    });
    messageOffset += messageCount;
  }
  return normalized.sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
}


function applyModeForDirection(direction: ConversationTimelinePageRequest['direction']): ConversationTimelinePageRecord['applyMode'] {

  switch (direction) {
    case 'older': return 'prepend';
    case 'newer': return 'append';
    case 'around': return 'replace';
    case 'initial':
    default:
      return 'replace';
  }
}

function emptyTimelinePage(conversationId: string, applyMode: ConversationTimelinePageRecord['applyMode']): ConversationTimelinePageRecord {
  return {
    conversationId,
    applyMode,
    chunks: [],
    pageInfo: {
      conversationId,
      chunkIds: [],
      totalChunks: 0,
      totalMessages: 0,
      hasOlder: false,
      hasNewer: false,
      loadedAt: Date.now()
    },
    state: createEmptyClientState()
  };
}

function timelinePageInfo(
  conversationId: string,
  allChunks: ConversationTimelineChunkIndexRecord[],
  selected: ConversationTimelineChunkIndexRecord[]
): ConversationTimelinePageRecord['pageInfo'] {
  const first = selected[0];
  const last = selected[selected.length - 1];
  const totalMessages = allChunks.reduce((sum, chunk) => sum + chunk.messageCount, 0);
  const firstIndex = first?.index ?? 0;
  const lastIndex = last?.index ?? -1;
  return {
    conversationId,
    chunkIds: selected.map((chunk) => chunk.id),
    totalChunks: allChunks.length,
    totalMessages,
    ...(first ? { startSeq: first.startSeq, oldestChunkId: first.id, previousCursor: first.id } : {}),
    ...(last ? { endSeq: last.endSeq, newestChunkId: last.id, nextCursor: last.id } : {}),
    hasOlder: firstIndex > 0,
    hasNewer: lastIndex >= 0 && lastIndex < allChunks.length - 1,
    loadedAt: Date.now()
  };
}

function chunkSummary(chunk: ConversationTimelineChunkIndexRecord): ConversationTimelineChunkSummaryRecord {
  return {
    id: chunk.id,
    index: chunk.index,
    startSeq: chunk.startSeq,
    endSeq: chunk.endSeq,
    messageCount: chunk.messageCount,
    messageOffsetStart: chunk.messageOffsetStart,
    messageOffsetEnd: chunk.messageOffsetEnd,
    toolCallCount: chunk.toolCallCount,
    toolCallEventCount: chunk.toolCallEventCount
  };
}


function yieldToExtensionHost(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
      return;
    }
    setTimeout(resolve, 0);
  });
}

export async function saveConversationTimelineDetail(paths: StoragePaths, conversationId: string, detail: ClientState): Promise<void> {
  const savedAt = new Date().toISOString();
  const root = conversationTimelineRoot(paths, conversationId);
  const previousIndex = await readJson<ConversationTimelineIndexFile>(vscode.Uri.joinPath(root, INDEX_FILE));
  const previousFiles = isConversationTimelineIndex(previousIndex, conversationId)
    ? filesReferencedByIndex(previousIndex)
    : [];

  await Promise.all([
    vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, CONVERSATION_TIMELINE_CHUNKS_DIR)),
    vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, CONVERSATION_TIMELINE_SIDECARS_DIR)),
    vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, CONVERSATION_TIMELINE_PROJECTIONS_DIR))
  ]);

  sortConversationTimelineDetail(detail);
  const chunks = conversationTimelineChunks(detail);
  const indexChunks: ConversationTimelineChunkIndexRecord[] = [];
  const projectionStates = createProjectionRuntimeStates(BUILTIN_TIMELINE_PROJECTIONS);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkId = index.toString().padStart(6, '0');
    const chunk = chunks[index];
    const seq = chunkSeqRange(chunk.messages);
    const messageHash = shortHash(stableJson({ messages: chunk.messages }));
    const sourceHash = shortHash(stableJson(chunk));
    const file = `${CONVERSATION_TIMELINE_CHUNKS_DIR}/${chunkId}.json`;
    const sidecars = await writeTimelineSidecars({ root, savedAt, conversationId, chunkId, chunk });
    const chunkFile: ConversationTimelineChunkFile = {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      conversationId,
      chunkId,
      startSeq: seq.startSeq,
      endSeq: seq.endSeq,
      messageHash,
      messages: chunk.messages
    };

    const projectionRefs = await writeProjectionCheckpoints({
      root,
      savedAt,
      conversationId,
      chunkId,
      chunk,
      seq,
      sourceHash,
      projectionStates
    });

    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), chunkFile);
    indexChunks.push({
      id: chunkId,
      file,
      index,
      startSeq: seq.startSeq,
      endSeq: seq.endSeq,
      messageCount: chunk.messages.length,
      messageOffsetStart: index * CONVERSATION_TIMELINE_CHUNK_SIZE + 1,
      messageOffsetEnd: index * CONVERSATION_TIMELINE_CHUNK_SIZE + chunk.messages.length,
      messageIds: chunk.messages.map((message) => message.id),
      toolCallIds: chunk.toolCalls.map((toolCall) => toolCall.id),
      toolCallCount: chunk.toolCalls.length,
      toolCallEventCount: chunk.toolCallEvents.length,
      messageHash,
      sourceHash,
      sidecars,
      projections: projectionRefs
    });
  }

  const nextIndex: ConversationTimelineIndexFile = {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    conversationId,
    chunkSize: CONVERSATION_TIMELINE_CHUNK_SIZE,
    chunks: indexChunks
  };
  await writeJson(vscode.Uri.joinPath(root, INDEX_FILE), nextIndex);
  await removeStaleTimelineFiles(root, previousFiles, filesReferencedByIndex(nextIndex));
}

export async function loadTimelineProjectionContext(
  paths: StoragePaths,
  conversationId: string,
  projectionKey: string,
  chunkId?: string
): Promise<TimelineProjectionContextRecord | undefined> {
  const root = conversationTimelineRoot(paths, conversationId);
  const index = await readJson<ConversationTimelineIndexFile>(vscode.Uri.joinPath(root, INDEX_FILE));
  if (!isConversationTimelineIndex(index, conversationId) || index.chunks.length === 0) return undefined;

  const spec = BUILTIN_TIMELINE_PROJECTIONS.find((candidate) => candidate.key === projectionKey);
  if (!spec) return undefined;

  const chunkIndex = chunkId
    ? index.chunks.findIndex((chunk) => chunk.id === chunkId)
    : index.chunks.length - 1;
  if (chunkIndex < 0) return undefined;

  const currentRecord = index.chunks[chunkIndex];
  const latestRecord = index.chunks[index.chunks.length - 1];
  const [previousCheckpoint, currentCheckpoint, latestCheckpoint] = await Promise.all([
    chunkIndex > 0 ? readProjectionCheckpoint(root, index.chunks[chunkIndex - 1], projectionKey) : Promise.resolve(undefined),
    readProjectionCheckpoint(root, currentRecord, projectionKey),
    readProjectionCheckpoint(root, latestRecord, projectionKey)
  ]);
  if (!currentCheckpoint || !latestCheckpoint) return undefined;

  return {
    conversationId,
    chunkId: currentRecord.id,
    projectionKey,
    snapshotBeforeChunk: previousCheckpoint?.snapshotAfterChunk ?? spec.emptySnapshot(),
    snapshotAfterChunk: currentCheckpoint.snapshotAfterChunk,
    latestSnapshot: latestCheckpoint.snapshotAfterChunk
  };
}

interface ProjectionRuntimeState<TSnapshot = unknown> {
  spec: TimelineProjectionSpec<TSnapshot>;
  snapshot: TSnapshot;
  operationIndex: number;
  previousCheckpointHash?: string;
}

function createProjectionRuntimeStates(specs: readonly TimelineProjectionSpec[]): ProjectionRuntimeState[] {
  return specs.map((spec): ProjectionRuntimeState => ({
    spec,
    snapshot: spec.emptySnapshot(),
    operationIndex: 0
  }));
}

async function writeProjectionCheckpoints(input: {
  root: vscode.Uri;
  savedAt: string;
  conversationId: string;
  chunkId: string;
  chunk: ConversationTimelineChunkData;
  seq: { startSeq: number; endSeq: number };
  sourceHash: string;
  projectionStates: ProjectionRuntimeState[];
}): Promise<Record<string, TimelineProjectionRefRecord>> {
  const refs: Record<string, TimelineProjectionRefRecord> = {};

  for (const state of input.projectionStates) {
    const result = state.spec.reduceChunk({
      conversationId: input.conversationId,
      chunkId: input.chunkId,
      chunk: input.chunk,
      previousSnapshot: state.snapshot,
      operationStartIndex: state.operationIndex
    });
    const checkpointHash = shortHash(stableJson({
      projectionKey: state.spec.key,
      chunkId: input.chunkId,
      sourceHash: input.sourceHash,
      previousCheckpointHash: state.previousCheckpointHash,
      snapshotAfterChunk: result.snapshotAfterChunk
    }));
    const file = `${CONVERSATION_TIMELINE_PROJECTIONS_DIR}/${safeProjectionKey(state.spec.key)}/${input.chunkId}.json`;
    const checkpoint: TimelineProjectionCheckpointFile = {
      schemaVersion: STORAGE_VERSION,
      savedAt: input.savedAt,
      conversationId: input.conversationId,
      chunkId: input.chunkId,
      projectionKey: state.spec.key,
      startSeq: input.seq.startSeq,
      endSeq: input.seq.endSeq,
      snapshotAfterChunk: result.snapshotAfterChunk,
      ...(result.operationCount !== undefined ? { operationCount: result.operationCount } : {}),
      sourceHash: input.sourceHash,
      checkpointHash,
      ...(state.previousCheckpointHash ? { previousCheckpointHash: state.previousCheckpointHash } : {})
    };

    await writeJson(vscode.Uri.joinPath(input.root, ...file.split('/')), checkpoint);
    refs[state.spec.key] = {
      file,
      checkpointHash,
      ...(state.previousCheckpointHash ? { previousCheckpointHash: state.previousCheckpointHash } : {}),
      ...(result.operationCount !== undefined ? { operationCount: result.operationCount } : {})
    };

    state.snapshot = result.snapshotAfterChunk;
    state.operationIndex = result.operationEndIndex;
    state.previousCheckpointHash = checkpointHash;
  }

  return refs;
}

async function writeTimelineSidecars(input: {
  root: vscode.Uri;
  savedAt: string;
  conversationId: string;
  chunkId: string;
  chunk: ConversationTimelineChunkData;
}): Promise<Record<TimelineSidecarKey, TimelineSidecarRefRecord>> {
  return {
    'message-revisions': await writeTimelineSidecar(input, 'message-revisions', input.chunk.messageRevisions),
    'message-current-revision-links': await writeTimelineSidecar(input, 'message-current-revision-links', input.chunk.messageCurrentRevisionLinks),
    'tool-calls': await writeTimelineSidecar(input, 'tool-calls', input.chunk.toolCalls),
    'tool-call-events': await writeTimelineSidecar(input, 'tool-call-events', input.chunk.toolCallEvents),
    'project-contexts': await writeTimelineSidecar(input, 'project-contexts', input.chunk.projectContexts),
    'shadow-repositories': await writeTimelineSidecar(input, 'shadow-repositories', input.chunk.shadowRepositories),
    'conversation-checkpoint-repository-links': await writeTimelineSidecar(input, 'conversation-checkpoint-repository-links', input.chunk.conversationCheckpointRepositoryLinks),
    checkpoints: await writeTimelineSidecar(input, 'checkpoints', input.chunk.checkpoints),
    'checkpoint-timeline-anchors': await writeTimelineSidecar(input, 'checkpoint-timeline-anchors', input.chunk.checkpointTimelineAnchors)
  };
}

async function writeTimelineSidecar<TRecord>(
  input: { root: vscode.Uri; savedAt: string; conversationId: string; chunkId: string },
  sidecarKey: TimelineSidecarKey,
  records: TRecord[]
): Promise<TimelineSidecarRefRecord> {
  const sourceHash = shortHash(stableJson(records));
  const file = `${CONVERSATION_TIMELINE_SIDECARS_DIR}/${sidecarKey}/${input.chunkId}.json`;
  await writeJson(vscode.Uri.joinPath(input.root, ...file.split('/')), {
    schemaVersion: STORAGE_VERSION,
    savedAt: input.savedAt,
    conversationId: input.conversationId,
    chunkId: input.chunkId,
    sidecarKey,
    sourceHash,
    count: records.length,
    records
  } satisfies ConversationTimelineSidecarFile<TRecord>);
  return { file, sourceHash, count: records.length };
}

function conversationTimelineChunks(detail: ClientState): ConversationTimelineChunkData[] {
  if (detail.messages.length === 0) return [];
  const chunks: ConversationTimelineChunkData[] = [];
  const orderedMessages = [...detail.messages].sort(compareMessagesBySeq);
  const anchoredCheckpointIds = new Set(detail.checkpointTimelineAnchors.map((anchor) => anchor.checkpointId));
  const initialCheckpoints = detail.checkpoints.filter((checkpoint) =>
    checkpoint.trigger === 'conversation_initial' && !anchoredCheckpointIds.has(checkpoint.id)
  );

  for (let offset = 0; offset < orderedMessages.length; offset += CONVERSATION_TIMELINE_CHUNK_SIZE) {
    const messages = orderedMessages.slice(offset, offset + CONVERSATION_TIMELINE_CHUNK_SIZE);
    const messageIds = new Set(messages.map((message) => message.id));
    const messageRevisions = detail.messageRevisions.filter((revision) => messageIds.has(revision.messageId));
    const revisionIds = new Set(messageRevisions.map((revision) => revision.id));
    const messageCurrentRevisionLinks = detail.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId) || revisionIds.has(link.revisionId));
    const toolCalls = detail.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
    const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
    const toolCallEvents = detail.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId));
    const checkpointTimelineAnchors = detail.checkpointTimelineAnchors.filter((anchor) => messageIds.has(anchor.floorMessageId));
    const checkpointIds = new Set(checkpointTimelineAnchors.map((anchor) => anchor.checkpointId));
    const checkpoints = detail.checkpoints.filter((checkpoint) =>
      checkpointIds.has(checkpoint.id)
      || (offset === 0 && initialCheckpoints.some((candidate) => candidate.id === checkpoint.id))
    );
    for (const checkpoint of checkpoints) checkpointIds.add(checkpoint.id);
    const shadowRepositoryIds = new Set(checkpoints.map((checkpoint) => checkpoint.shadowRepositoryId));
    const projectContextIds = new Set(checkpoints.map((checkpoint) => checkpoint.projectContextId));
    const conversationCheckpointRepositoryLinks = detail.conversationCheckpointRepositoryLinks.filter((link) => {
      const matches = shadowRepositoryIds.has(link.shadowRepositoryId) || projectContextIds.has(link.projectContextId);
      if (matches) {
        shadowRepositoryIds.add(link.shadowRepositoryId);
        projectContextIds.add(link.projectContextId);
      }
      return matches;
    });
    const projectContexts = detail.projectContexts.filter((projectContext) => projectContextIds.has(projectContext.id));
    const shadowRepositories = detail.shadowRepositories.filter((repository) => shadowRepositoryIds.has(repository.id));
    chunks.push({
      messages,
      messageRevisions: messageRevisions.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
      messageCurrentRevisionLinks: messageCurrentRevisionLinks.sort((left, right) => left.id.localeCompare(right.id)),
      toolCalls: toolCalls.sort(compareToolCalls),
      toolCallEvents: toolCallEvents.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id)),
      projectContexts: projectContexts.sort((left, right) => left.id.localeCompare(right.id)),
      shadowRepositories: shadowRepositories.sort((left, right) => left.id.localeCompare(right.id)),
      conversationCheckpointRepositoryLinks: conversationCheckpointRepositoryLinks.sort((left, right) => left.id.localeCompare(right.id)),
      checkpoints: checkpoints.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
      checkpointTimelineAnchors: checkpointTimelineAnchors.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    });
  }

  return chunks;
}

async function readConversationTimelineChunk(root: vscode.Uri, record: ConversationTimelineChunkIndexRecord): Promise<ConversationTimelineChunkData | undefined> {
  const file = await readJson<ConversationTimelineChunkFile>(vscode.Uri.joinPath(root, ...record.file.split('/')));
  if (!file || file.schemaVersion !== STORAGE_VERSION || file.chunkId !== record.id) return undefined;
  if (file.messageHash !== record.messageHash) return undefined;

  const [
    messageRevisions,
    messageCurrentRevisionLinks,
    toolCalls,
    toolCallEvents,
    projectContexts,
    shadowRepositories,
    conversationCheckpointRepositoryLinks,
    checkpoints,
    checkpointTimelineAnchors
  ] = await Promise.all([
    readTimelineSidecar<MessageRevisionRecord>(root, record, 'message-revisions'),
    readTimelineSidecar<MessageCurrentRevisionLinkRecord>(root, record, 'message-current-revision-links'),
    readTimelineSidecar<ToolCallRecord>(root, record, 'tool-calls'),
    readTimelineSidecar<ToolCallEventRecord>(root, record, 'tool-call-events'),
    readTimelineSidecar<ProjectContextRecord>(root, record, 'project-contexts'),
    readTimelineSidecar<ShadowRepositoryRecord>(root, record, 'shadow-repositories'),
    readTimelineSidecar<ConversationCheckpointRepositoryLinkRecord>(root, record, 'conversation-checkpoint-repository-links'),
    readTimelineSidecar<CheckpointRecord>(root, record, 'checkpoints'),
    readTimelineSidecar<CheckpointTimelineAnchorRecord>(root, record, 'checkpoint-timeline-anchors')
  ]);
  if (!messageRevisions || !messageCurrentRevisionLinks || !toolCalls || !toolCallEvents || !projectContexts || !shadowRepositories || !conversationCheckpointRepositoryLinks || !checkpoints || !checkpointTimelineAnchors) return undefined;

  const chunk: ConversationTimelineChunkData = {
    messages: file.messages,
    messageRevisions,
    messageCurrentRevisionLinks,
    toolCalls,
    toolCallEvents,
    projectContexts,
    shadowRepositories,
    conversationCheckpointRepositoryLinks,
    checkpoints,
    checkpointTimelineAnchors
  };
  if (shortHash(stableJson(chunk)) !== record.sourceHash) return undefined;
  return chunk;
}

async function readTimelineSidecar<TRecord>(root: vscode.Uri, record: ConversationTimelineChunkIndexRecord, sidecarKey: TimelineSidecarKey): Promise<TRecord[] | undefined> {
  const ref = record.sidecars[sidecarKey];
  if (!ref) return undefined;
  const file = await readJson<ConversationTimelineSidecarFile<TRecord>>(vscode.Uri.joinPath(root, ...ref.file.split('/')));
  if (!file || file.schemaVersion !== STORAGE_VERSION || file.chunkId !== record.id || file.sidecarKey !== sidecarKey) return undefined;
  if (file.sourceHash !== ref.sourceHash || file.count !== ref.count) return undefined;
  return file.records;
}

async function readProjectionCheckpoint(root: vscode.Uri, record: ConversationTimelineChunkIndexRecord, projectionKey: string): Promise<TimelineProjectionCheckpointFile | undefined> {
  const projection = record.projections[projectionKey];
  if (!projection) return undefined;
  const checkpoint = await readJson<TimelineProjectionCheckpointFile>(vscode.Uri.joinPath(root, ...projection.file.split('/')));
  if (!checkpoint || checkpoint.schemaVersion !== STORAGE_VERSION || checkpoint.chunkId !== record.id || checkpoint.projectionKey !== projectionKey) return undefined;
  if (checkpoint.sourceHash !== record.sourceHash || checkpoint.checkpointHash !== projection.checkpointHash) return undefined;
  return checkpoint;
}

function conversationTimelineRoot(paths: StoragePaths, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.conversationsRootUri, CONVERSATION_DETAILS_DIR, safeShardName(conversationId), CONVERSATION_MESSAGES_DIR);
}

function chunkSeqRange(messages: readonly MessageRecord[]): { startSeq: number; endSeq: number } {
  const seqs = messages.map((message) => message.seq);
  return {
    startSeq: Math.min(...seqs),
    endSeq: Math.max(...seqs)
  };
}

function sortConversationTimelineDetail(state: ClientState): void {
  state.messages = uniqueById(state.messages);
  state.messageRevisions = uniqueById(state.messageRevisions);
  state.messageCurrentRevisionLinks = uniqueById(state.messageCurrentRevisionLinks);
  state.toolCalls = uniqueById(state.toolCalls);
  state.toolCallEvents = uniqueById(state.toolCallEvents);
  state.projectContexts = uniqueById(state.projectContexts);
  state.shadowRepositories = uniqueById(state.shadowRepositories);
  state.conversationCheckpointRepositoryLinks = uniqueById(state.conversationCheckpointRepositoryLinks);
  state.checkpoints = uniqueById(state.checkpoints);
  state.checkpointTimelineAnchors = uniqueById(state.checkpointTimelineAnchors);
  state.messages.sort(compareMessagesBySeq);
  state.messageRevisions.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  state.messageCurrentRevisionLinks.sort((left, right) => left.id.localeCompare(right.id));
  state.toolCalls.sort(compareToolCalls);
  state.toolCallEvents.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  state.projectContexts.sort((left, right) => left.id.localeCompare(right.id));
  state.shadowRepositories.sort((left, right) => left.id.localeCompare(right.id));
  state.conversationCheckpointRepositoryLinks.sort((left, right) => left.id.localeCompare(right.id));
  state.checkpoints.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  state.checkpointTimelineAnchors.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function uniqueById<TRecord extends { id: string }>(records: TRecord[]): TRecord[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function compareMessagesBySeq(left: MessageRecord, right: MessageRecord): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function compareToolCalls(left: ToolCallRecord, right: ToolCallRecord): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function isConversationTimelineIndex(value: ConversationTimelineIndexFile | undefined, conversationId: string): value is ConversationTimelineIndexFile {
  return !!value
    && value.schemaVersion === STORAGE_VERSION
    && value.conversationId === conversationId
    && Array.isArray(value.chunks)
    && value.chunks.every((chunk) => {
      return typeof chunk.id === 'string'
        && typeof chunk.file === 'string'
        && typeof chunk.messageHash === 'string'
        && typeof chunk.sourceHash === 'string'
        && hasAllSidecars(chunk.sidecars)
        && !!chunk.projections
        && typeof chunk.projections === 'object';
    });
}

function hasAllSidecars(value: unknown): value is Record<TimelineSidecarKey, TimelineSidecarRefRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<Record<TimelineSidecarKey, TimelineSidecarRefRecord>>;
  return TIMELINE_SIDECAR_KEYS.every((key) => typeof record[key]?.file === 'string' && typeof record[key]?.sourceHash === 'string');
}

function filesReferencedByIndex(index: ConversationTimelineIndexFile): string[] {
  return index.chunks.flatMap((chunk) => [
    chunk.file,
    ...Object.values(chunk.sidecars).map((sidecar) => sidecar.file),
    ...Object.values(chunk.projections).map((projection) => projection.file)
  ]);
}

async function removeStaleTimelineFiles(root: vscode.Uri, previousFiles: readonly string[], currentFiles: readonly string[]): Promise<void> {
  const current = new Set(currentFiles);
  await Promise.all(previousFiles.filter((file) => !current.has(file)).map(async (file) => {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, ...file.split('/')));
    } catch (error) {
      if (!isFileNotFound(error)) console.warn(`[LimCode] Failed to delete stale timeline file: ${file}`, error);
    }
  }));
}

function safeProjectionKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'projection';
}

function safeShardName(id: string): string {
  const slug = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'conversation';
  return `${slug}-${shortHash(id)}`;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function isFileNotFound(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  const text = [candidate.name, candidate.code, candidate.message, candidate.stack, String(error)]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
  return /FileNotFound|EntryNotFound|ENOENT|ENOTDIR|not found|no such file|不存在|无法解析不存在的文件/i.test(text);
}
