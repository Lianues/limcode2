import * as vscode from 'vscode';
import type {
  ClientState,
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
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

type TimelineSidecarKey = 'message-revisions' | 'message-current-revision-links' | 'tool-calls' | 'tool-call-events';

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
  startSeq: number;
  endSeq: number;
  messageCount: number;
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

const TIMELINE_SIDECAR_KEYS: readonly TimelineSidecarKey[] = [
  'message-revisions',
  'message-current-revision-links',
  'tool-calls',
  'tool-call-events'
] as const;

export async function loadConversationTimelineDetail(paths: StoragePaths, conversationId: string): Promise<ClientState | undefined> {
  const root = conversationTimelineRoot(paths, conversationId);
  const index = await readJson<ConversationTimelineIndexFile>(vscode.Uri.joinPath(root, INDEX_FILE));
  if (!isConversationTimelineIndex(index, conversationId)) return undefined;

  const state = createEmptyClientState();
  const chunkFiles = await Promise.all(index.chunks.map((chunk) => readConversationTimelineChunk(root, chunk)));
  for (const chunk of chunkFiles) {
    if (!chunk) continue;
    state.messages.push(...chunk.messages);
    state.messageRevisions.push(...chunk.messageRevisions);
    state.messageCurrentRevisionLinks.push(...chunk.messageCurrentRevisionLinks);
    state.toolCalls.push(...chunk.toolCalls);
    state.toolCallEvents.push(...chunk.toolCallEvents);
  }
  sortConversationTimelineDetail(state);
  return state;
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
      startSeq: seq.startSeq,
      endSeq: seq.endSeq,
      messageCount: chunk.messages.length,
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
    'tool-call-events': await writeTimelineSidecar(input, 'tool-call-events', input.chunk.toolCallEvents)
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

  for (let offset = 0; offset < orderedMessages.length; offset += CONVERSATION_TIMELINE_CHUNK_SIZE) {
    const messages = orderedMessages.slice(offset, offset + CONVERSATION_TIMELINE_CHUNK_SIZE);
    const messageIds = new Set(messages.map((message) => message.id));
    const messageRevisions = detail.messageRevisions.filter((revision) => messageIds.has(revision.messageId));
    const revisionIds = new Set(messageRevisions.map((revision) => revision.id));
    const messageCurrentRevisionLinks = detail.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId) || revisionIds.has(link.revisionId));
    const toolCalls = detail.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
    const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
    const toolCallEvents = detail.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId));
    chunks.push({
      messages,
      messageRevisions: messageRevisions.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
      messageCurrentRevisionLinks: messageCurrentRevisionLinks.sort((left, right) => left.id.localeCompare(right.id)),
      toolCalls: toolCalls.sort(compareToolCalls),
      toolCallEvents: toolCallEvents.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
    });
  }

  return chunks;
}

async function readConversationTimelineChunk(root: vscode.Uri, record: ConversationTimelineChunkIndexRecord): Promise<ConversationTimelineChunkData | undefined> {
  const file = await readJson<ConversationTimelineChunkFile>(vscode.Uri.joinPath(root, ...record.file.split('/')));
  if (!file || file.schemaVersion !== STORAGE_VERSION || file.chunkId !== record.id) return undefined;
  if (file.messageHash !== record.messageHash) return undefined;

  const [messageRevisions, messageCurrentRevisionLinks, toolCalls, toolCallEvents] = await Promise.all([
    readTimelineSidecar<MessageRevisionRecord>(root, record, 'message-revisions'),
    readTimelineSidecar<MessageCurrentRevisionLinkRecord>(root, record, 'message-current-revision-links'),
    readTimelineSidecar<ToolCallRecord>(root, record, 'tool-calls'),
    readTimelineSidecar<ToolCallEventRecord>(root, record, 'tool-call-events')
  ]);
  if (!messageRevisions || !messageCurrentRevisionLinks || !toolCalls || !toolCallEvents) return undefined;

  const chunk: ConversationTimelineChunkData = {
    messages: file.messages,
    messageRevisions,
    messageCurrentRevisionLinks,
    toolCalls,
    toolCallEvents
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
  state.messages.sort(compareMessagesBySeq);
  state.messageRevisions.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  state.messageCurrentRevisionLinks.sort((left, right) => left.id.localeCompare(right.id));
  state.toolCalls.sort(compareToolCalls);
  state.toolCallEvents.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
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
