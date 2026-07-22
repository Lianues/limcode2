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
import { isFunctionResponsePart } from '../../../shared/protocol';
import { createEmptyClientState } from '../../../shared/clientStateSchema';
import type { TimelineProjectionContextRecord, TimelineProjectionRefRecord } from '../../../shared/timelineProjection';
import { INDEX_FILE, STORAGE_VERSION } from './constants';
import { createVscodeStoragePaths } from './paths';
import { isFileNotFoundError, readJsonStrict, writeJson } from './json';
import { withStorageResourceLock } from './storageResourceLock';
import {
  cleanupInactiveStorageGenerations,
  createStorageGenerationLocation,
  isSafeStorageGenerationId,
  STORAGE_GENERATIONS_DIR
} from './storageGeneration';
import { BUILTIN_TIMELINE_PROJECTIONS, type ConversationTimelineChunkData, type TimelineProjectionSpec } from './timelineProjections';
import { externalizeClientStateAttachments, markClientStateAttachmentsForClient } from './attachmentStore';
import { assertUniqueRecords } from '../../utils/uniqueIds';

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

type TimelineFileKind =
  | 'conversationTimeline.index'
  | 'conversationTimeline.chunk'
  | 'conversationTimeline.sidecar'
  | 'conversationTimeline.projection';

interface ConversationTimelineIndexFile {
  kind: 'conversationTimeline.index';
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  generation: string;
  conversationId: string;
  chunkSize: number;
  chunks: ConversationTimelineChunkIndexRecord[];
}

interface ConversationTimelineChunkIndexRecord {
  generation: string;
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
  /** 只校验 generations/{generation}/chunks/{chunkId}.json 内的 messages。 */
  messageHash: string;
  /** 校验 messages + sidecars 的完整投影输入，用于 projection checkpoint。 */
  sourceHash: string;
  sidecars: Record<TimelineSidecarKey, TimelineSidecarRefRecord>;
  projections: Record<string, TimelineProjectionFileRefRecord>;
}

interface TimelineSidecarRefRecord {
  generation: string;
  file: string;
  sourceHash: string;
  count: number;
}

interface TimelineProjectionFileRefRecord extends TimelineProjectionRefRecord {
  generation: string;
}

interface ConversationTimelineChunkFile {
  kind: 'conversationTimeline.chunk';
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  generation: string;
  conversationId: string;
  chunkId: string;
  startSeq: number;
  endSeq: number;
  messageHash: string;
  messages: MessageRecord[];
}

interface ConversationTimelineSidecarFile<TRecord = unknown> {
  kind: 'conversationTimeline.sidecar';
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  generation: string;
  conversationId: string;
  chunkId: string;
  sidecarKey: TimelineSidecarKey;
  sourceHash: string;
  count: number;
  records: TRecord[];
}

interface TimelineProjectionCheckpointFile<TSnapshot = unknown> {
  kind: 'conversationTimeline.projection';
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  generation: string;
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

interface ConversationTimelineIndexSnapshot {
  index: ConversationTimelineIndexFile;
  uri: vscode.Uri;
}

interface TimelineLoadOptions {
  validateProjections?: boolean;
}

interface TimelineUiLoadOptions {
  strictErrors?: boolean;
}

interface StoreRecord {
  id: string;
}

export interface ConversationTimelineStoreTestHookContext {
  rootUri: vscode.Uri;
  conversationId: string;
  generation: string;
  attempt?: number;
}

export interface ConversationTimelineStoreTestHooks {
  /** 测试专用：chunk/sidecar/projection 完整写入后、根 active manifest 原子发布前触发。 */
  beforePublishIndex?: (context: ConversationTimelineStoreTestHookContext) => void | Promise<void>;
  /** 测试专用：reader 首次读取 active manifest 后、读取 indexed files 前触发。 */
  afterReadIndexBeforeFiles?: (context: ConversationTimelineStoreTestHookContext) => void | Promise<void>;
}

export const __conversationTimelineStoreTestHooks: ConversationTimelineStoreTestHooks = {};

const CONVERSATION_DETAILS_DIR = 'details';
const CONVERSATION_MESSAGES_DIR = 'messages';
const CONVERSATION_TIMELINE_CHUNKS_DIR = 'chunks';
const CONVERSATION_TIMELINE_SIDECARS_DIR = 'sidecars';
const CONVERSATION_TIMELINE_PROJECTIONS_DIR = 'projections';
const CONVERSATION_TIMELINE_CHUNK_SIZE = 100;
const TIMELINE_LOAD_BATCH_SIZE = 32;
const DEFAULT_TIMELINE_PAGE_CHUNKS = 2;
const MAX_TIMELINE_PAGE_CHUNKS = 5;
const TIMELINE_READER_MAX_ATTEMPTS = 3;
const CHUNK_ID_PATTERN = /^\d{6}$/;

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

const TIMELINE_DETAIL_TABLE_KEYS = [
  'messages',
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'toolCalls',
  'toolCallEvents',
  'projectContexts',
  'shadowRepositories',
  'conversationCheckpointRepositoryLinks',
  'checkpoints',
  'checkpointTimelineAnchors'
] as const;

export async function loadConversationTimelineDetail(paths: StoragePaths, conversationId: string): Promise<ClientState | undefined> {
  const root = conversationTimelineRoot(paths, conversationId);
  return loadTimelineForUi(root, conversationId, 'conversation timeline detail', undefined, async (index) => {
    const state = await loadTimelineDetailFromIndexStrict(root, index);
    markClientStateAttachmentsForClient(state);
    return state;
  }, { strictErrors: true });
}

export async function loadConversationTimelinePage(paths: StoragePaths, request: ConversationTimelinePageRequest): Promise<ConversationTimelinePageRecord> {
  const root = conversationTimelineRoot(paths, request.conversationId);
  return loadTimelineForUi(root, request.conversationId, 'conversation timeline page', emptyTimelinePage(request.conversationId, applyModeForDirection(request.direction)), async (index) => {
    if (index.chunks.length === 0) {
      return emptyTimelinePage(request.conversationId, applyModeForDirection(request.direction));
    }

    const selected = selectTimelinePageChunks(index.chunks, request);
    const state = createEmptyClientState();
    const chunkFiles = await Promise.all(selected.map((chunk) => readConversationTimelineChunkStrict(root, chunk)));
    for (const chunk of chunkFiles) copyTimelineChunkToState(state, chunk);
    sortConversationTimelineDetail(state);
    markClientStateAttachmentsForClient(state);

    const projections: Record<string, TimelineProjectionContextRecord> = {};
    const projectionChunk = selected[0];
    for (const projectionKey of request.includeProjections ?? []) {
      if (!projectionChunk) continue;
      if (!BUILTIN_TIMELINE_PROJECTIONS.some((candidate) => candidate.key === projectionKey)) continue;
      projections[projectionKey] = await loadTimelineProjectionContextFromIndexStrict(root, index, projectionKey, projectionChunk.id);
    }

    return {
      conversationId: request.conversationId,
      applyMode: applyModeForDirection(request.direction),
      chunks: selected.map(chunkSummary),
      pageInfo: timelinePageInfo(request.conversationId, index.chunks, selected),
      state,
      ...(Object.keys(projections).length > 0 ? { projections } : {})
    };
  });
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
  return loadTimelineForUi(root, request.conversationId, 'conversation timeline range', undefined, async (index) => {
    if (index.chunks.length === 0) return undefined;
    const selected = selectTimelineRangeChunks(index.chunks, request);
    if (selected.length === 0) return undefined;
    const state = createEmptyClientState();
    const chunkFiles = await Promise.all(selected.map((chunk) => readConversationTimelineChunkStrict(root, chunk)));
    for (const chunk of chunkFiles) copyTimelineChunkToState(state, chunk);
    sortConversationTimelineDetail(state);
    markClientStateAttachmentsForClient(state);
    return state;
  });
}

export async function truncateConversationTimeline(paths: StoragePaths, request: {
  conversationId: string;
  anchorMessageId: string;
  keepAnchor: boolean;
}): Promise<{ conversationId: string; removedMessageIds: string[] }> {
  const root = conversationTimelineRoot(paths, request.conversationId);
  return withStorageResourceLock(root, async () => {
    const previous = await loadTimelineIndexForWrite(root, request.conversationId, { allowMissing: true });
    if (!previous || previous.index.chunks.length === 0) return { conversationId: request.conversationId, removedMessageIds: [] };

    const detail = await loadTimelineDetailFromIndexStrict(root, previous.index, { validateProjections: true });
    sortConversationTimelineDetail(detail);
    const anchorMessageIndex = detail.messages.findIndex((message) => message.id === request.anchorMessageId);
    if (anchorMessageIndex < 0) return { conversationId: request.conversationId, removedMessageIds: [] };

    const keepCount = request.keepAnchor ? anchorMessageIndex + 1 : anchorMessageIndex;
    const keptMessageIds = new Set(detail.messages.slice(0, keepCount).map((message) => message.id));
    const removedMessageIds = detail.messages.slice(keepCount).map((message) => message.id);
    if (removedMessageIds.length === 0) return { conversationId: request.conversationId, removedMessageIds: [] };

    const nextDetail = timelineChunkDataToClientState(filterTimelineChunkByMessageIds(detail, keptMessageIds));
    await publishTimelineDetail(paths, root, request.conversationId, nextDetail, previous.index);
    return { conversationId: request.conversationId, removedMessageIds };
  });
}

export async function saveConversationTimelineDetail(paths: StoragePaths, conversationId: string, detail: ClientState): Promise<void> {
  const storageDetail = await externalizeClientStateAttachments(paths, detail);
  sortConversationTimelineDetail(storageDetail);
  const root = conversationTimelineRoot(paths, conversationId);
  await withStorageResourceLock(root, async () => {
    const previous = await loadTimelineIndexForWrite(root, conversationId, { allowMissing: true });
    await publishTimelineDetail(paths, root, conversationId, storageDetail, previous?.index);
  });
}

export async function mergeConversationTimelineDetailIntoStore(paths: StoragePaths, conversationId: string, detail: ClientState): Promise<void> {
  const storageDetail = await externalizeClientStateAttachments(paths, detail);
  sortConversationTimelineDetail(storageDetail);
  const root = conversationTimelineRoot(paths, conversationId);
  await withStorageResourceLock(root, async () => {
    const previous = await loadTimelineIndexForWrite(root, conversationId, { allowMissing: true });
    const next = previous
      ? await loadTimelineDetailFromIndexStrict(root, previous.index, { validateProjections: true })
      : createEmptyClientState();
    mergeTimelineDetailTables(next, storageDetail);
    sortConversationTimelineDetail(next);
    await publishTimelineDetail(paths, root, conversationId, next, previous?.index);
  });
}

export async function mutateConversationTimelineDetailInStore(
  paths: StoragePaths,
  conversationId: string,
  mutate: (detail: ClientState) => void | Promise<void>
): Promise<void> {
  const root = conversationTimelineRoot(paths, conversationId);
  await withStorageResourceLock(root, async () => {
    const previous = await loadTimelineIndexForWrite(root, conversationId, { allowMissing: true });
    const detail = previous
      ? await loadTimelineDetailFromIndexStrict(root, previous.index, { validateProjections: true })
      : createEmptyClientState();
    await mutate(detail);
    const storageDetail = await externalizeClientStateAttachments(paths, detail);
    sortConversationTimelineDetail(storageDetail);
    await publishTimelineDetail(paths, root, conversationId, storageDetail, previous?.index);
  });
}

export async function saveConversationTimelineRenderDetailIncremental(paths: StoragePaths, conversationId: string, detail: ClientState): Promise<boolean> {
  const storageDetail = await externalizeClientStateAttachments(paths, detail);
  sortConversationTimelineDetail(storageDetail);
  if (!hasTimelineDetailRecords(storageDetail)) return true;

  const root = conversationTimelineRoot(paths, conversationId);
  return withStorageResourceLock(root, async () => {
    const previous = await loadTimelineIndexManifestForWrite(root, conversationId, { allowMissing: true });
    if (!previous || previous.index.chunks.length === 0) return false;

    const tailPlan = analyzeTailIncrementalPatch(previous.index, storageDetail);
    if (tailPlan.kind === 'tail') {
      const tailSaved = await publishTimelineTailIncremental(root, conversationId, previous.index, storageDetail, tailPlan);
      if (tailSaved) return true;
    }

    await publishMergedTimelineDetailFromIndex(paths, root, conversationId, previous.index, storageDetail);
    return true;
  });
}

export async function loadTimelineProjectionContext(
  paths: StoragePaths,
  conversationId: string,
  projectionKey: string,
  chunkId?: string
): Promise<TimelineProjectionContextRecord | undefined> {
  const root = conversationTimelineRoot(paths, conversationId);
  return loadTimelineForUi(root, conversationId, 'conversation timeline projection', undefined, async (index) => {
    if (index.chunks.length === 0) return undefined;
    if (!BUILTIN_TIMELINE_PROJECTIONS.some((candidate) => candidate.key === projectionKey)) return undefined;
    return loadTimelineProjectionContextFromIndexStrict(root, index, projectionKey, chunkId);
  });
}

async function loadTimelineForUi<T>(
  root: vscode.Uri,
  conversationId: string,
  label: string,
  fallback: T,
  load: (index: ConversationTimelineIndexFile) => Promise<T>,
  options: TimelineUiLoadOptions = {}
): Promise<T> {
  for (let attempt = 1; attempt <= TIMELINE_READER_MAX_ATTEMPTS; attempt += 1) {
    const initial = await tryLoadTimelineIndexForUi(root, conversationId, options);
    if (!initial) return fallback;

    await __conversationTimelineStoreTestHooks.afterReadIndexBeforeFiles?.({
      rootUri: root,
      conversationId,
      generation: initial.index.generation,
      attempt
    });

    let value: T;
    try {
      value = await load(initial.index);
    } catch (error) {
      if (attempt < TIMELINE_READER_MAX_ATTEMPTS && await timelineIndexGenerationChanged(root, conversationId, initial.index.generation, options)) continue;
      if (options.strictErrors) throw error;
      console.warn(`[LimCode] Failed to load ${label}:`, error);
      return fallback;
    }

    const confirmed = await tryLoadTimelineIndexForUi(root, conversationId, options);
    if (!confirmed) return fallback;
    if (confirmed.index.generation === initial.index.generation) return value;
  }

  const message = `${label} generation changed while reading; giving up after limited retries.`;
  if (options.strictErrors) throw new Error(message);
  console.warn(`[LimCode] ${message}`);
  return fallback;
}

async function tryLoadTimelineIndexForUi(root: vscode.Uri, conversationId: string, options: TimelineUiLoadOptions = {}): Promise<ConversationTimelineIndexSnapshot | undefined> {
  const indexUri = vscode.Uri.joinPath(root, INDEX_FILE);
  const result = await readJsonStrict<unknown>(indexUri);
  if (result.status === 'missing') {
    const traces = await findExistingTimelineTracesForUi(root);
    if (traces.length > 0) {
      const error = new Error(`Conversation timeline index is missing while timeline traces exist: ${traces.join(', ')}`);
      if (options.strictErrors) throw error;
      console.warn('[LimCode]', error.message);
    }
    return undefined;
  }
  if (result.status === 'invalid') {
    if (options.strictErrors) throw new Error(`Conversation timeline index JSON is invalid: ${indexUri.fsPath}`);
    console.warn(`[LimCode] Conversation timeline index JSON is invalid: ${indexUri.fsPath}`, result.error);
    return undefined;
  }
  if (result.status === 'ioError') {
    if (options.strictErrors) throw new Error(`Failed to read conversation timeline index: ${indexUri.fsPath}`);
    console.warn(`[LimCode] Failed to read conversation timeline index: ${indexUri.fsPath}`, result.error);
    return undefined;
  }

  try {
    return parseTimelineIndex(result.value, indexUri, conversationId);
  } catch (error) {
    if (options.strictErrors) throw error;
    console.warn('[LimCode] Conversation timeline index structure is invalid:', error);
    return undefined;
  }
}

async function timelineIndexGenerationChanged(root: vscode.Uri, conversationId: string, generation: string, options: TimelineUiLoadOptions = {}): Promise<boolean> {
  const current = await tryLoadTimelineIndexForUi(root, conversationId, options);
  return !!current && current.index.generation !== generation;
}

async function loadTimelineIndexForWrite(root: vscode.Uri, conversationId: string, options: { allowMissing: boolean }): Promise<ConversationTimelineIndexSnapshot | undefined> {
  const snapshot = await loadTimelineIndexManifestForWrite(root, conversationId, options);
  if (!snapshot) return undefined;
  await validateTimelineIndexReferencesForWrite(root, snapshot.index);
  return snapshot;
}

async function loadTimelineIndexManifestForWrite(root: vscode.Uri, conversationId: string, options: { allowMissing: boolean }): Promise<ConversationTimelineIndexSnapshot | undefined> {
  const indexUri = vscode.Uri.joinPath(root, INDEX_FILE);
  const result = await readJsonStrict<unknown>(indexUri);
  if (result.status === 'missing') {
    const traces = await findExistingTimelineTraces(root);
    if (traces.length > 0) {
      throw new Error(`Conversation timeline index is missing but storage contains timeline traces: ${traces.join(', ')}`);
    }
    if (options.allowMissing) return undefined;
    throw new Error(`Conversation timeline index is missing: ${indexUri.fsPath}`);
  }
  if (result.status === 'invalid') throw new Error(`Conversation timeline index JSON is invalid: ${indexUri.fsPath}`);
  if (result.status === 'ioError') throw new Error(`Failed to read conversation timeline index: ${indexUri.fsPath}`);

  return parseTimelineIndex(result.value, indexUri, conversationId);
}

async function validateTimelineIndexReferencesForWrite(root: vscode.Uri, index: ConversationTimelineIndexFile): Promise<void> {
  for (let chunkIndex = 0; chunkIndex < index.chunks.length; chunkIndex += TIMELINE_LOAD_BATCH_SIZE) {
    await Promise.all(index.chunks.slice(chunkIndex, chunkIndex + TIMELINE_LOAD_BATCH_SIZE).map((chunk) =>
      readConversationTimelineChunkStrict(root, chunk, { validateProjections: true })
    ));
    if (chunkIndex + TIMELINE_LOAD_BATCH_SIZE < index.chunks.length) await yieldToExtensionHost();
  }
}

async function loadTimelineDetailFromIndexStrict(root: vscode.Uri, index: ConversationTimelineIndexFile, options: TimelineLoadOptions = {}): Promise<ClientState> {
  const state = createEmptyClientState();
  for (let chunkIndex = 0; chunkIndex < index.chunks.length; chunkIndex += TIMELINE_LOAD_BATCH_SIZE) {
    const chunkFiles = await Promise.all(index.chunks.slice(chunkIndex, chunkIndex + TIMELINE_LOAD_BATCH_SIZE).map((chunk) =>
      readConversationTimelineChunkStrict(root, chunk, options)
    ));
    for (const chunk of chunkFiles) copyTimelineChunkToState(state, chunk);
    if (chunkIndex + TIMELINE_LOAD_BATCH_SIZE < index.chunks.length) await yieldToExtensionHost();
  }
  sortConversationTimelineDetail(state);
  return state;
}

type TailIncrementalPatchAnalysis =
  | { kind: 'tail'; suffixStartIndex: number }
  | { kind: 'fallback'; reason: string };

async function publishMergedTimelineDetailFromIndex(
  paths: StoragePaths,
  root: vscode.Uri,
  conversationId: string,
  previousIndex: ConversationTimelineIndexFile,
  patch: ClientState
): Promise<void> {
  const next = await loadTimelineDetailFromIndexStrict(root, previousIndex, { validateProjections: true });
  mergeTimelineDetailTables(next, patch);
  sortConversationTimelineDetail(next);
  await publishTimelineDetail(paths, root, conversationId, next, previousIndex);
}

async function publishTimelineTailIncremental(
  root: vscode.Uri,
  conversationId: string,
  previousIndex: ConversationTimelineIndexFile,
  patch: ClientState,
  plan: Extract<TailIncrementalPatchAnalysis, { kind: 'tail' }>
): Promise<boolean> {
  const prefixChunks = previousIndex.chunks.slice(0, plan.suffixStartIndex);
  const previousSuffixRecord = previousIndex.chunks[plan.suffixStartIndex];
  if (!previousSuffixRecord) return false;

  const previousSuffix = await readConversationTimelineChunkStrict(root, previousSuffixRecord, { validateProjections: true });
  const suffixState = timelineChunkDataToClientState(previousSuffix);
  mergeTimelineDetailTables(suffixState, patch);
  sortConversationTimelineDetail(suffixState);
  const suffixChunks = conversationTimelineChunks(suffixState);
  if (!canReuseTimelinePrefixForSuffix(prefixChunks, suffixChunks)) return false;

  const projectionStates = await createProjectionRuntimeStatesFromPrefix(root, prefixChunks);
  if (!projectionStates) return false;

  const savedAt = new Date().toISOString();
  const generation = createStorageGenerationLocation(root);
  await ensureTimelineGenerationRoots(generation.rootUri);

  const indexChunks: ConversationTimelineChunkIndexRecord[] = [];
  let visibleMessageOffset = 0;
  for (let index = 0; index < prefixChunks.length; index += 1) {
    const reused = reindexReusedTimelineChunkRecord(prefixChunks[index], index, visibleMessageOffset);
    indexChunks.push(reused);
    visibleMessageOffset += reused.messageCount;
  }

  for (let suffixIndex = 0; suffixIndex < suffixChunks.length; suffixIndex += 1) {
    const index = prefixChunks.length + suffixIndex;
    const chunkRecord = await writeTimelineChunkIndexRecord({
      root,
      savedAt,
      generation: generation.id,
      conversationId,
      chunkId: index.toString().padStart(6, '0'),
      index,
      chunk: suffixChunks[suffixIndex],
      visibleMessageOffset,
      projectionStates
    });
    indexChunks.push(chunkRecord);
    visibleMessageOffset += chunkRecord.messageCount;
  }

  const nextIndex: ConversationTimelineIndexFile = {
    kind: 'conversationTimeline.index',
    schemaVersion: STORAGE_VERSION,
    savedAt,
    generation: generation.id,
    conversationId,
    chunkSize: CONVERSATION_TIMELINE_CHUNK_SIZE,
    chunks: indexChunks
  };

  await __conversationTimelineStoreTestHooks.beforePublishIndex?.({ rootUri: root, conversationId, generation: generation.id });

  await writeJson(vscode.Uri.joinPath(root, INDEX_FILE), nextIndex);
  await cleanupOldTimelineGenerationsAfterPublish(root, nextIndex, previousIndex);
  return true;
}

function analyzeTailIncrementalPatch(index: ConversationTimelineIndexFile, patch: ClientState): TailIncrementalPatchAnalysis {
  const lastChunkIndex = index.chunks.length - 1;
  const lastChunk = index.chunks[lastChunkIndex];
  if (!lastChunk) return { kind: 'fallback', reason: 'missing tail chunk' };

  const messageChunkIndex = timelineMessageChunkIndex(index);
  if (!messageChunkIndex) return { kind: 'fallback', reason: 'duplicate indexed message id' };
  if (!timelineToolCallChunkIndex(index)) return { kind: 'fallback', reason: 'duplicate indexed tool call id' };

  const tailMessageIds = new Set(lastChunk.messageIds);
  for (const message of patch.messages) {
    if (message.conversationId !== index.conversationId) return { kind: 'fallback', reason: 'message conversation mismatch' };
    const existingChunkIndex = messageChunkIndex.get(message.id);
    if (existingChunkIndex === undefined) {
      if (!Number.isFinite(message.seq) || message.seq < lastChunk.endSeq) return { kind: 'fallback', reason: 'new message is not at tail' };
      tailMessageIds.add(message.id);
      continue;
    }
    if (existingChunkIndex !== lastChunkIndex) return { kind: 'fallback', reason: 'existing message is outside tail chunk' };
  }

  for (const revision of patch.messageRevisions) {
    if (!tailMessageIds.has(revision.messageId)) return { kind: 'fallback', reason: 'revision is outside tail chunk' };
    if (revision.conversationId !== index.conversationId) return { kind: 'fallback', reason: 'revision conversation mismatch' };
  }

  for (const link of patch.messageCurrentRevisionLinks) {
    if (!tailMessageIds.has(link.messageId)) return { kind: 'fallback', reason: 'current revision link is outside tail chunk' };
  }

  const tailToolCallIds = new Set(lastChunk.toolCallIds);
  for (const toolCall of patch.toolCalls) {
    if (!tailMessageIds.has(toolCall.messageId)) return { kind: 'fallback', reason: 'tool call is outside tail chunk' };
    tailToolCallIds.add(toolCall.id);
  }

  for (const event of patch.toolCallEvents) {
    if (!tailToolCallIds.has(event.toolCallId)) return { kind: 'fallback', reason: 'tool call event is outside tail chunk' };
  }

  const tailCheckpointIds = new Set<string>();
  for (const anchor of patch.checkpointTimelineAnchors) {
    if (anchor.conversationId !== index.conversationId) return { kind: 'fallback', reason: 'checkpoint anchor conversation mismatch' };
    if (!tailMessageIds.has(anchor.floorMessageId)) return { kind: 'fallback', reason: 'checkpoint anchor is outside tail chunk' };
    tailCheckpointIds.add(anchor.checkpointId);
  }

  const tailProjectContextIds = new Set<string>();
  const tailShadowRepositoryIds = new Set<string>();
  for (const checkpoint of patch.checkpoints) {
    if (checkpoint.conversationId !== index.conversationId) return { kind: 'fallback', reason: 'checkpoint conversation mismatch' };
    const belongsToTail = tailCheckpointIds.has(checkpoint.id)
      || (lastChunkIndex === 0 && checkpoint.trigger === 'conversation_initial');
    if (!belongsToTail) return { kind: 'fallback', reason: 'checkpoint is outside tail chunk' };
    tailCheckpointIds.add(checkpoint.id);
    tailProjectContextIds.add(checkpoint.projectContextId);
    tailShadowRepositoryIds.add(checkpoint.shadowRepositoryId);
  }

  const unmatchedRepositoryLinks = new Set(patch.conversationCheckpointRepositoryLinks);
  let matchedRepositoryLink = true;
  while (matchedRepositoryLink) {
    matchedRepositoryLink = false;
    for (const link of [...unmatchedRepositoryLinks]) {
      if (link.conversationId !== index.conversationId) return { kind: 'fallback', reason: 'checkpoint repository link conversation mismatch' };
      const matchesTail = tailProjectContextIds.has(link.projectContextId) || tailShadowRepositoryIds.has(link.shadowRepositoryId);
      if (!matchesTail) continue;
      tailProjectContextIds.add(link.projectContextId);
      tailShadowRepositoryIds.add(link.shadowRepositoryId);
      unmatchedRepositoryLinks.delete(link);
      matchedRepositoryLink = true;
    }
  }
  if (unmatchedRepositoryLinks.size > 0) return { kind: 'fallback', reason: 'checkpoint repository link is outside tail chunk' };

  for (const projectContext of patch.projectContexts) {
    if (!tailProjectContextIds.has(projectContext.id)) return { kind: 'fallback', reason: 'project context is outside tail chunk' };
  }

  for (const repository of patch.shadowRepositories) {
    if (!tailShadowRepositoryIds.has(repository.id)) return { kind: 'fallback', reason: 'shadow repository is outside tail chunk' };
  }

  return { kind: 'tail', suffixStartIndex: lastChunkIndex };
}

function canReuseTimelinePrefixForSuffix(
  prefixChunks: readonly ConversationTimelineChunkIndexRecord[],
  suffixChunks: readonly ConversationTimelineChunkData[]
): boolean {
  if (suffixChunks.length === 0) return false;
  const lastPrefix = prefixChunks[prefixChunks.length - 1];
  if (!lastPrefix) return true;
  const firstSuffixSeq = chunkDisplaySeqRange(suffixChunks[0].messages);
  return firstSuffixSeq.startSeq >= lastPrefix.endSeq;
}

async function createProjectionRuntimeStatesFromPrefix(
  root: vscode.Uri,
  prefixChunks: readonly ConversationTimelineChunkIndexRecord[]
): Promise<ProjectionRuntimeState[] | undefined> {
  const states = createProjectionRuntimeStates(BUILTIN_TIMELINE_PROJECTIONS);
  const lastPrefix = prefixChunks[prefixChunks.length - 1];
  if (!lastPrefix) return states;

  const operationCounts: number[] = [];
  for (const state of states) {
    const count = sumProjectionOperationCount(prefixChunks, state.spec.key);
    if (count === undefined || !lastPrefix.projections[state.spec.key]) return undefined;
    operationCounts.push(count);
  }

  const checkpoints = await Promise.all(states.map((state) => readProjectionCheckpointStrict(root, lastPrefix, state.spec.key)));
  for (let index = 0; index < states.length; index += 1) {
    const checkpoint = checkpoints[index];
    states[index].snapshot = checkpoint.snapshotAfterChunk;
    states[index].previousCheckpointHash = checkpoint.checkpointHash;
    states[index].operationIndex = operationCounts[index];
  }
  return states;
}

function sumProjectionOperationCount(prefixChunks: readonly ConversationTimelineChunkIndexRecord[], projectionKey: string): number | undefined {
  let count = 0;
  for (const chunk of prefixChunks) {
    const operationCount = chunk.projections[projectionKey]?.operationCount;
    if (operationCount === undefined) return undefined;
    count += operationCount;
  }
  return count;
}

function reindexReusedTimelineChunkRecord(
  record: ConversationTimelineChunkIndexRecord,
  index: number,
  visibleMessageOffset: number
): ConversationTimelineChunkIndexRecord {
  return {
    ...record,
    index,
    messageOffsetStart: visibleMessageOffset + 1,
    messageOffsetEnd: visibleMessageOffset + record.messageCount,
    messageIds: [...record.messageIds],
    toolCallIds: [...record.toolCallIds],
    sidecars: { ...record.sidecars },
    projections: { ...record.projections }
  };
}

function timelineMessageChunkIndex(index: ConversationTimelineIndexFile): Map<string, number> | undefined {
  const messageChunkIndex = new Map<string, number>();
  for (const chunk of index.chunks) {
    for (const messageId of chunk.messageIds) {
      if (messageChunkIndex.has(messageId)) return undefined;
      messageChunkIndex.set(messageId, chunk.index);
    }
  }
  return messageChunkIndex;
}

function timelineToolCallChunkIndex(index: ConversationTimelineIndexFile): Map<string, number> | undefined {
  const toolCallChunkIndex = new Map<string, number>();
  for (const chunk of index.chunks) {
    for (const toolCallId of chunk.toolCallIds) {
      if (toolCallChunkIndex.has(toolCallId)) return undefined;
      toolCallChunkIndex.set(toolCallId, chunk.index);
    }
  }
  return toolCallChunkIndex;
}


async function readConversationTimelineChunkStrict(root: vscode.Uri, record: ConversationTimelineChunkIndexRecord, options: TimelineLoadOptions = {}): Promise<ConversationTimelineChunkData> {
  const uri = vscode.Uri.joinPath(root, ...record.file.split('/'));
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') throw new Error(`Indexed conversation timeline chunk is missing: ${uri.fsPath}`);
  if (result.status === 'invalid') throw new Error(`Indexed conversation timeline chunk JSON is invalid: ${uri.fsPath}`);
  if (result.status === 'ioError') throw new Error(`Failed to read indexed conversation timeline chunk: ${uri.fsPath}`);

  const file = parseTimelineChunkFile(result.value, uri, record);
  const computedMessageHash = shortHash(stableJson({ messages: file.messages }));
  if (computedMessageHash !== record.messageHash || file.messageHash !== record.messageHash) {
    throw new Error(`Conversation timeline chunk message hash mismatch: ${uri.fsPath}`);
  }

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
    readTimelineSidecarStrict<MessageRevisionRecord>(root, record, 'message-revisions'),
    readTimelineSidecarStrict<MessageCurrentRevisionLinkRecord>(root, record, 'message-current-revision-links'),
    readTimelineSidecarStrict<ToolCallRecord>(root, record, 'tool-calls'),
    readTimelineSidecarStrict<ToolCallEventRecord>(root, record, 'tool-call-events'),
    readTimelineSidecarStrict<ProjectContextRecord>(root, record, 'project-contexts'),
    readTimelineSidecarStrict<ShadowRepositoryRecord>(root, record, 'shadow-repositories'),
    readTimelineSidecarStrict<ConversationCheckpointRepositoryLinkRecord>(root, record, 'conversation-checkpoint-repository-links'),
    readTimelineSidecarStrict<CheckpointRecord>(root, record, 'checkpoints'),
    readTimelineSidecarStrict<CheckpointTimelineAnchorRecord>(root, record, 'checkpoint-timeline-anchors')
  ]);

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

  if (shortHash(stableJson(chunk)) !== record.sourceHash) {
    throw new Error(`Conversation timeline chunk source hash mismatch: ${uri.fsPath}`);
  }
  validateChunkRecordMetadata(record, chunk, uri);

  if (options.validateProjections) {
    await Promise.all(Object.keys(record.projections).map((projectionKey) => readProjectionCheckpointStrict(root, record, projectionKey)));
  }

  return chunk;
}

async function readTimelineSidecarStrict<TRecord>(root: vscode.Uri, record: ConversationTimelineChunkIndexRecord, sidecarKey: TimelineSidecarKey): Promise<TRecord[]> {
  const ref = record.sidecars[sidecarKey];
  if (!ref) throw new Error(`Conversation timeline sidecar ref is missing: ${record.id}:${sidecarKey}`);
  const uri = vscode.Uri.joinPath(root, ...ref.file.split('/'));
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') throw new Error(`Indexed conversation timeline sidecar is missing: ${uri.fsPath}`);
  if (result.status === 'invalid') throw new Error(`Indexed conversation timeline sidecar JSON is invalid: ${uri.fsPath}`);
  if (result.status === 'ioError') throw new Error(`Failed to read indexed conversation timeline sidecar: ${uri.fsPath}`);

  const file = parseTimelineSidecarFile<TRecord>(result.value, uri, record, sidecarKey, ref);
  const computedSourceHash = shortHash(stableJson(file.records));
  if (computedSourceHash !== ref.sourceHash || file.sourceHash !== ref.sourceHash || file.count !== ref.count || file.records.length !== ref.count) {
    throw new Error(`Conversation timeline sidecar hash/count mismatch: ${uri.fsPath}`);
  }
  return file.records;
}

async function readProjectionCheckpointStrict(root: vscode.Uri, record: ConversationTimelineChunkIndexRecord, projectionKey: string): Promise<TimelineProjectionCheckpointFile> {
  const projection = record.projections[projectionKey];
  if (!projection) throw new Error(`Conversation timeline projection ref is missing: ${record.id}:${projectionKey}`);
  const uri = vscode.Uri.joinPath(root, ...projection.file.split('/'));
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') throw new Error(`Indexed conversation timeline projection is missing: ${uri.fsPath}`);
  if (result.status === 'invalid') throw new Error(`Indexed conversation timeline projection JSON is invalid: ${uri.fsPath}`);
  if (result.status === 'ioError') throw new Error(`Failed to read indexed conversation timeline projection: ${uri.fsPath}`);

  const checkpoint = parseTimelineProjectionFile(result.value, uri, record, projectionKey, projection);
  const computedCheckpointHash = shortHash(stableJson({
    projectionKey,
    chunkId: record.id,
    sourceHash: record.sourceHash,
    previousCheckpointHash: checkpoint.previousCheckpointHash,
    snapshotAfterChunk: checkpoint.snapshotAfterChunk
  }));
  if (checkpoint.sourceHash !== record.sourceHash || checkpoint.checkpointHash !== projection.checkpointHash || checkpoint.checkpointHash !== computedCheckpointHash) {
    throw new Error(`Conversation timeline projection hash mismatch: ${uri.fsPath}`);
  }
  return checkpoint;
}

async function loadTimelineProjectionContextFromIndexStrict(
  root: vscode.Uri,
  index: ConversationTimelineIndexFile,
  projectionKey: string,
  chunkId?: string
): Promise<TimelineProjectionContextRecord> {
  const spec = BUILTIN_TIMELINE_PROJECTIONS.find((candidate) => candidate.key === projectionKey);
  if (!spec) throw new Error(`Unknown conversation timeline projection: ${projectionKey}`);

  const chunkIndex = chunkId
    ? index.chunks.findIndex((chunk) => chunk.id === chunkId)
    : index.chunks.length - 1;
  if (chunkIndex < 0) throw new Error(`Conversation timeline projection chunk is missing: ${chunkId ?? '(latest)'}`);

  const currentRecord = index.chunks[chunkIndex];
  const latestRecord = index.chunks[index.chunks.length - 1];
  if (!currentRecord || !latestRecord) throw new Error('Conversation timeline projection requires at least one chunk.');

  const [previousCheckpoint, currentCheckpoint, latestCheckpoint] = await Promise.all([
    chunkIndex > 0 ? readProjectionCheckpointStrict(root, index.chunks[chunkIndex - 1], projectionKey) : Promise.resolve(undefined),
    readProjectionCheckpointStrict(root, currentRecord, projectionKey),
    readProjectionCheckpointStrict(root, latestRecord, projectionKey)
  ]);

  return {
    conversationId: index.conversationId,
    chunkId: currentRecord.id,
    currentChunkStartSeq: currentRecord.startSeq,
    currentChunkEndSeq: currentRecord.endSeq,
    latestChunkId: latestRecord.id,
    latestChunkStartSeq: latestRecord.startSeq,
    latestChunkEndSeq: latestRecord.endSeq,
    projectionKey,
    snapshotBeforeChunk: previousCheckpoint?.snapshotAfterChunk ?? spec.emptySnapshot(),
    snapshotAfterChunk: currentCheckpoint.snapshotAfterChunk,
    latestSnapshot: latestCheckpoint.snapshotAfterChunk
  };
}

async function publishTimelineDetail(
  paths: StoragePaths,
  root: vscode.Uri,
  conversationId: string,
  detail: ClientState,
  previousIndex: ConversationTimelineIndexFile | undefined
): Promise<void> {
  const savedAt = new Date().toISOString();
  const generation = createStorageGenerationLocation(root);
  await ensureTimelineGenerationRoots(generation.rootUri);

  sortConversationTimelineDetail(detail);
  const chunks = conversationTimelineChunks(detail);
  const indexChunks: ConversationTimelineChunkIndexRecord[] = [];
  const projectionStates = createProjectionRuntimeStates(BUILTIN_TIMELINE_PROJECTIONS);

  let visibleMessageOffset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunkRecord = await writeTimelineChunkIndexRecord({
      root,
      savedAt,
      generation: generation.id,
      conversationId,
      chunkId: index.toString().padStart(6, '0'),
      index,
      chunk: chunks[index],
      visibleMessageOffset,
      projectionStates
    });
    indexChunks.push(chunkRecord);
    visibleMessageOffset += chunkRecord.messageCount;
  }

  const nextIndex: ConversationTimelineIndexFile = {
    kind: 'conversationTimeline.index',
    schemaVersion: STORAGE_VERSION,
    savedAt,
    generation: generation.id,
    conversationId,
    chunkSize: CONVERSATION_TIMELINE_CHUNK_SIZE,
    chunks: indexChunks
  };

  await __conversationTimelineStoreTestHooks.beforePublishIndex?.({ rootUri: root, conversationId, generation: generation.id });

  await writeJson(vscode.Uri.joinPath(root, INDEX_FILE), nextIndex);
  await cleanupOldTimelineGenerationsAfterPublish(root, nextIndex, previousIndex);
}

async function writeTimelineChunkIndexRecord(input: {
  root: vscode.Uri;
  savedAt: string;
  generation: string;
  conversationId: string;
  chunkId: string;
  index: number;
  chunk: ConversationTimelineChunkData;
  visibleMessageOffset: number;
  projectionStates: ProjectionRuntimeState[];
}): Promise<ConversationTimelineChunkIndexRecord> {
  const visibleMessages = input.chunk.messages.filter(isTimelineVisibleMessage);
  const seq = chunkDisplaySeqRange(input.chunk.messages);
  const messageHash = shortHash(stableJson({ messages: input.chunk.messages }));
  const sourceHash = shortHash(stableJson(input.chunk));
  const file = timelineChunkFile(input.generation, input.chunkId);
  const sidecars = await writeTimelineSidecars({
    root: input.root,
    savedAt: input.savedAt,
    generation: input.generation,
    conversationId: input.conversationId,
    chunkId: input.chunkId,
    chunk: input.chunk
  });
  const projectionRefs = await writeProjectionCheckpoints({
    root: input.root,
    savedAt: input.savedAt,
    generation: input.generation,
    conversationId: input.conversationId,
    chunkId: input.chunkId,
    chunk: input.chunk,
    seq,
    sourceHash,
    projectionStates: input.projectionStates
  });

  await writeJson(vscode.Uri.joinPath(input.root, ...file.split('/')), {
    kind: 'conversationTimeline.chunk',
    schemaVersion: STORAGE_VERSION,
    savedAt: input.savedAt,
    generation: input.generation,
    conversationId: input.conversationId,
    chunkId: input.chunkId,
    startSeq: seq.startSeq,
    endSeq: seq.endSeq,
    messageHash,
    messages: input.chunk.messages
  } satisfies ConversationTimelineChunkFile);

  return {
    generation: input.generation,
    id: input.chunkId,
    file,
    index: input.index,
    startSeq: seq.startSeq,
    endSeq: seq.endSeq,
    messageCount: visibleMessages.length,
    messageOffsetStart: input.visibleMessageOffset + 1,
    messageOffsetEnd: input.visibleMessageOffset + visibleMessages.length,
    messageIds: input.chunk.messages.map((message) => message.id),
    toolCallIds: input.chunk.toolCalls.map((toolCall) => toolCall.id),
    toolCallCount: input.chunk.toolCalls.length,
    toolCallEventCount: input.chunk.toolCallEvents.length,
    messageHash,
    sourceHash,
    sidecars,
    projections: projectionRefs
  };
}


async function ensureTimelineGenerationRoots(generationRoot: vscode.Uri): Promise<void> {
  await Promise.all([
    vscode.workspace.fs.createDirectory(generationRoot),
    vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(generationRoot, CONVERSATION_TIMELINE_CHUNKS_DIR)),
    ...TIMELINE_SIDECAR_KEYS.map((key) => vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(generationRoot, CONVERSATION_TIMELINE_SIDECARS_DIR, key))),
    ...BUILTIN_TIMELINE_PROJECTIONS.map((spec) => vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(generationRoot, CONVERSATION_TIMELINE_PROJECTIONS_DIR, safeProjectionKey(spec.key))))
  ]);
}

async function cleanupOldTimelineGenerationsAfterPublish(
  root: vscode.Uri,
  currentIndex: ConversationTimelineIndexFile,
  previousIndex: ConversationTimelineIndexFile | undefined
): Promise<void> {
  try {
    const retained = new Set<string>([
      ...generationsReferencedByIndex(currentIndex),
      ...(previousIndex ? generationsReferencedByIndex(previousIndex) : [])
    ]);
    const result = await cleanupInactiveStorageGenerations(root, retained);
    for (const failure of result.failed) {
      console.warn(`[LimCode] Failed to prune conversation timeline generation: ${failure.generation.id}`, failure.error);
    }
  } catch (error) {
    console.warn('[LimCode] Failed to prune inactive conversation timeline generations:', error);
  }
}

function generationsReferencedByIndex(index: ConversationTimelineIndexFile): string[] {
  const generations = new Set<string>();
  if (isSafeStorageGenerationId(index.generation)) generations.add(index.generation);
  for (const chunk of index.chunks) {

    if (isSafeStorageGenerationId(chunk.generation)) generations.add(chunk.generation);
    for (const sidecar of Object.values(chunk.sidecars)) if (isSafeStorageGenerationId(sidecar.generation)) generations.add(sidecar.generation);
    for (const projection of Object.values(chunk.projections)) if (isSafeStorageGenerationId(projection.generation)) generations.add(projection.generation);
  }
  return [...generations];
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
  generation: string;
  conversationId: string;
  chunkId: string;
  chunk: ConversationTimelineChunkData;
  seq: { startSeq: number; endSeq: number };
  sourceHash: string;
  projectionStates: ProjectionRuntimeState[];
}): Promise<Record<string, TimelineProjectionFileRefRecord>> {
  const refs: Record<string, TimelineProjectionFileRefRecord> = {};

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
    const file = timelineProjectionFile(input.generation, state.spec.key, input.chunkId);
    await writeJson(vscode.Uri.joinPath(input.root, ...file.split('/')), {
      kind: 'conversationTimeline.projection',
      schemaVersion: STORAGE_VERSION,
      savedAt: input.savedAt,
      generation: input.generation,
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
    } satisfies TimelineProjectionCheckpointFile);

    refs[state.spec.key] = {
      generation: input.generation,
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
  generation: string;
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
  input: { root: vscode.Uri; savedAt: string; generation: string; conversationId: string; chunkId: string },
  sidecarKey: TimelineSidecarKey,
  records: TRecord[]
): Promise<TimelineSidecarRefRecord> {
  const sourceHash = shortHash(stableJson(records));
  const file = timelineSidecarFile(input.generation, sidecarKey, input.chunkId);
  await writeJson(vscode.Uri.joinPath(input.root, ...file.split('/')), {
    kind: 'conversationTimeline.sidecar',
    schemaVersion: STORAGE_VERSION,
    savedAt: input.savedAt,
    generation: input.generation,
    conversationId: input.conversationId,
    chunkId: input.chunkId,
    sidecarKey,
    sourceHash,
    count: records.length,
    records
  } satisfies ConversationTimelineSidecarFile<TRecord>);
  return { generation: input.generation, file, sourceHash, count: records.length };
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

function filterTimelineChunkByMessageIds(chunk: ConversationTimelineChunkData, messageIds: ReadonlySet<string>): ConversationTimelineChunkData {
  const messages = chunk.messages.filter((message) => messageIds.has(message.id));
  const keptMessageIds = new Set(messages.map((message) => message.id));
  const messageRevisions = chunk.messageRevisions.filter((revision) => keptMessageIds.has(revision.messageId));
  const revisionIds = new Set(messageRevisions.map((revision) => revision.id));
  const messageCurrentRevisionLinks = chunk.messageCurrentRevisionLinks.filter((link) => keptMessageIds.has(link.messageId) || revisionIds.has(link.revisionId));
  const toolCalls = chunk.toolCalls.filter((toolCall) => keptMessageIds.has(toolCall.messageId));
  const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
  const toolCallEvents = chunk.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId));
  const checkpointTimelineAnchors = chunk.checkpointTimelineAnchors.filter((anchor) => keptMessageIds.has(anchor.floorMessageId));
  const checkpointIds = new Set(checkpointTimelineAnchors.map((anchor) => anchor.checkpointId));
  const checkpoints = chunk.checkpoints.filter((checkpoint) => checkpointIds.has(checkpoint.id) || (messages.length > 0 && checkpoint.trigger === 'conversation_initial'));
  const shadowRepositoryIds = new Set(checkpoints.map((checkpoint) => checkpoint.shadowRepositoryId));
  const projectContextIds = new Set(checkpoints.map((checkpoint) => checkpoint.projectContextId));
  const conversationCheckpointRepositoryLinks = chunk.conversationCheckpointRepositoryLinks.filter((link) => {
    const matches = shadowRepositoryIds.has(link.shadowRepositoryId) || projectContextIds.has(link.projectContextId);
    if (matches) {
      shadowRepositoryIds.add(link.shadowRepositoryId);
      projectContextIds.add(link.projectContextId);
    }
    return matches;
  });
  const projectContexts = chunk.projectContexts.filter((projectContext) => projectContextIds.has(projectContext.id));
  const shadowRepositories = chunk.shadowRepositories.filter((repository) => shadowRepositoryIds.has(repository.id));
  return {
    messages,
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
}

function timelineChunkDataToClientState(chunk: ConversationTimelineChunkData): ClientState {
  const state = createEmptyClientState();
  copyTimelineChunkToState(state, chunk);
  sortConversationTimelineDetail(state);
  return state;
}

function copyTimelineChunkToState(state: ClientState, chunk: ConversationTimelineChunkData): void {
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

function hasTimelineDetailRecords(detail: ClientState): boolean {
  return TIMELINE_DETAIL_TABLE_KEYS.some((key) => detail[key].length > 0);
}


function mergeTimelineDetailTables(target: ClientState, source: ClientState): void {
  const writableTarget = target as unknown as Record<string, StoreRecord[]>;
  const readableSource = source as unknown as Record<string, StoreRecord[]>;
  for (const key of TIMELINE_DETAIL_TABLE_KEYS) {
    writableTarget[key] = upsertTimelineRecordsById(writableTarget[key] ?? [], readableSource[key] ?? []);
  }
}

function upsertTimelineRecordsById<TRecord extends StoreRecord>(existing: readonly TRecord[], next: readonly TRecord[]): TRecord[] {
  assertUniqueRecords(existing, 'conversationTimeline.existing');
  assertUniqueRecords(next, 'conversationTimeline.next');
  const byId = new Map<string, TRecord>();
  for (const record of existing) byId.set(record.id, record);
  for (const record of next) byId.set(record.id, record);
  return [...byId.values()];
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

function parseTimelineIndex(value: unknown, uri: vscode.Uri, conversationId: string): ConversationTimelineIndexSnapshot {
  const index = value as Partial<ConversationTimelineIndexFile> | undefined;
  if (!isPlainObject(index)) throw new Error(`Conversation timeline index must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(index, ['kind', 'schemaVersion', 'savedAt', 'generation', 'conversationId', 'chunkSize', 'chunks'])) {
    throw new Error(`Conversation timeline index has unknown fields: ${uri.fsPath}`);
  }
  if (index.kind !== 'conversationTimeline.index') throw new Error(`Conversation timeline index kind is invalid: ${uri.fsPath}`);
  if (index.schemaVersion !== STORAGE_VERSION) throw new Error(`Unsupported conversation timeline index schema: ${uri.fsPath}`);
  if (typeof index.savedAt !== 'string' || !index.savedAt.trim()) throw new Error(`Conversation timeline index savedAt is invalid: ${uri.fsPath}`);
  if (typeof index.generation !== 'string' || !isSafeStorageGenerationId(index.generation)) throw new Error(`Conversation timeline index generation is invalid: ${uri.fsPath}`);
  if (index.conversationId !== conversationId) throw new Error(`Conversation timeline index conversation mismatch: ${uri.fsPath}`);
  if (index.chunkSize !== CONVERSATION_TIMELINE_CHUNK_SIZE) throw new Error(`Conversation timeline index chunkSize is invalid: ${uri.fsPath}`);
  if (!Array.isArray(index.chunks)) throw new Error(`Conversation timeline index chunks are invalid: ${uri.fsPath}`);

  const chunks: ConversationTimelineChunkIndexRecord[] = [];
  let visibleMessageOffset = 0;
  let previousEndSeq: number | undefined;
  const seenChunkIds = new Set<string>();
  for (let chunkIndex = 0; chunkIndex < index.chunks.length; chunkIndex += 1) {
    const chunk = parseTimelineChunkIndexRecord(index.chunks[chunkIndex], uri, chunkIndex);
    if (seenChunkIds.has(chunk.id)) throw new Error(`Duplicate conversation timeline chunk id: ${chunk.id}`);
    seenChunkIds.add(chunk.id);
    if (chunk.index !== chunkIndex) throw new Error(`Conversation timeline chunk index is not canonical: ${uri.fsPath}`);
    if (chunk.messageOffsetStart !== visibleMessageOffset + 1) throw new Error(`Conversation timeline chunk messageOffsetStart mismatch: ${uri.fsPath}`);
    if (chunk.messageOffsetEnd !== visibleMessageOffset + chunk.messageCount) throw new Error(`Conversation timeline chunk messageOffsetEnd mismatch: ${uri.fsPath}`);
    if (previousEndSeq !== undefined && chunk.startSeq < previousEndSeq) throw new Error(`Conversation timeline chunk seq order is invalid: ${uri.fsPath}`);
    visibleMessageOffset += chunk.messageCount;
    previousEndSeq = chunk.endSeq;
    chunks.push(chunk);
  }

  return {
    uri,
    index: {
      kind: 'conversationTimeline.index',
      schemaVersion: STORAGE_VERSION,
      savedAt: index.savedAt,
      generation: index.generation,
      conversationId,
      chunkSize: CONVERSATION_TIMELINE_CHUNK_SIZE,
      chunks
    }
  };
}

function parseTimelineChunkIndexRecord(value: unknown, uri: vscode.Uri, expectedIndex: number): ConversationTimelineChunkIndexRecord {
  const chunk = value as Partial<ConversationTimelineChunkIndexRecord> | undefined;
  if (!isPlainObject(chunk)) throw new Error(`Conversation timeline chunk index must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(chunk, [
    'generation',
    'id',
    'file',
    'index',
    'startSeq',
    'endSeq',
    'messageCount',
    'messageOffsetStart',
    'messageOffsetEnd',
    'messageIds',
    'toolCallIds',
    'toolCallCount',
    'toolCallEventCount',
    'messageHash',
    'sourceHash',
    'sidecars',
    'projections'
  ])) {
    throw new Error(`Conversation timeline chunk index has unknown fields: ${uri.fsPath}`);
  }
  if (typeof chunk.generation !== 'string' || !isSafeStorageGenerationId(chunk.generation)) throw new Error(`Conversation timeline chunk generation is invalid: ${uri.fsPath}`);
  if (typeof chunk.id !== 'string' || !CHUNK_ID_PATTERN.test(chunk.id)) throw new Error(`Conversation timeline chunk id is invalid: ${uri.fsPath}`);
  if (chunk.file !== timelineChunkFile(chunk.generation, chunk.id)) throw new Error(`Conversation timeline chunk file is invalid: ${uri.fsPath}`);
  if (!isSafeNonNegativeInteger(chunk.index) || chunk.index !== expectedIndex) throw new Error(`Conversation timeline chunk index is invalid: ${uri.fsPath}`);
  if (!isFiniteNumber(chunk.startSeq) || !isFiniteNumber(chunk.endSeq) || chunk.endSeq < chunk.startSeq) throw new Error(`Conversation timeline chunk seq range is invalid: ${uri.fsPath}`);
  if (!isSafeNonNegativeInteger(chunk.messageCount)) throw new Error(`Conversation timeline chunk messageCount is invalid: ${uri.fsPath}`);
  if (!isSafePositiveInteger(chunk.messageOffsetStart) || !isSafeNonNegativeInteger(chunk.messageOffsetEnd)) throw new Error(`Conversation timeline chunk message offsets are invalid: ${uri.fsPath}`);
  if (!isStringArray(chunk.messageIds) || !isStringArray(chunk.toolCallIds)) throw new Error(`Conversation timeline chunk id lists are invalid: ${uri.fsPath}`);
  if (!isSafeNonNegativeInteger(chunk.toolCallCount) || !isSafeNonNegativeInteger(chunk.toolCallEventCount)) throw new Error(`Conversation timeline chunk tool counts are invalid: ${uri.fsPath}`);
  if (typeof chunk.messageHash !== 'string' || !chunk.messageHash.trim() || typeof chunk.sourceHash !== 'string' || !chunk.sourceHash.trim()) {
    throw new Error(`Conversation timeline chunk hashes are invalid: ${uri.fsPath}`);
  }

  return {
    generation: chunk.generation,
    id: chunk.id,
    file: chunk.file,
    index: chunk.index,
    startSeq: chunk.startSeq,
    endSeq: chunk.endSeq,
    messageCount: chunk.messageCount,
    messageOffsetStart: chunk.messageOffsetStart,
    messageOffsetEnd: chunk.messageOffsetEnd,
    messageIds: [...chunk.messageIds],
    toolCallIds: [...chunk.toolCallIds],
    toolCallCount: chunk.toolCallCount,
    toolCallEventCount: chunk.toolCallEventCount,
    messageHash: chunk.messageHash,
    sourceHash: chunk.sourceHash,
    sidecars: parseTimelineSidecarRefs(chunk.sidecars, uri, chunk.generation, chunk.id),
    projections: parseTimelineProjectionRefs(chunk.projections, uri, chunk.id)
  };
}

function parseTimelineSidecarRefs(value: unknown, uri: vscode.Uri, chunkGeneration: string, chunkId: string): Record<TimelineSidecarKey, TimelineSidecarRefRecord> {
  if (!isPlainObject(value)) throw new Error(`Conversation timeline sidecar refs are invalid: ${uri.fsPath}`);
  const keys = Object.keys(value).sort();
  const expectedKeys = [...TIMELINE_SIDECAR_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Conversation timeline sidecar refs have invalid keys: ${uri.fsPath}`);
  }
  const refs = {} as Record<TimelineSidecarKey, TimelineSidecarRefRecord>;
  for (const key of TIMELINE_SIDECAR_KEYS) {
    const ref = (value as Record<string, unknown>)[key] as Partial<TimelineSidecarRefRecord> | undefined;
    if (!isPlainObject(ref) || !hasOnlyKeys(ref, ['generation', 'file', 'sourceHash', 'count'])) throw new Error(`Conversation timeline sidecar ref is invalid: ${uri.fsPath}`);
    if (ref.generation !== chunkGeneration || !isSafeStorageGenerationId(ref.generation)) throw new Error(`Conversation timeline sidecar generation mismatch: ${uri.fsPath}`);
    if (ref.file !== timelineSidecarFile(ref.generation, key, chunkId)) throw new Error(`Conversation timeline sidecar file is invalid: ${uri.fsPath}`);
    if (typeof ref.sourceHash !== 'string' || !ref.sourceHash.trim()) throw new Error(`Conversation timeline sidecar hash is invalid: ${uri.fsPath}`);
    if (!isSafeNonNegativeInteger(ref.count)) throw new Error(`Conversation timeline sidecar count is invalid: ${uri.fsPath}`);
    refs[key] = { generation: ref.generation, file: ref.file, sourceHash: ref.sourceHash, count: ref.count };
  }
  return refs;
}

function parseTimelineProjectionRefs(value: unknown, uri: vscode.Uri, chunkId: string): Record<string, TimelineProjectionFileRefRecord> {
  if (!isPlainObject(value)) throw new Error(`Conversation timeline projection refs are invalid: ${uri.fsPath}`);
  const refs: Record<string, TimelineProjectionFileRefRecord> = {};
  for (const [projectionKey, rawRef] of Object.entries(value)) {
    const ref = rawRef as Partial<TimelineProjectionFileRefRecord> | undefined;
    if (!projectionKey.trim()) throw new Error(`Conversation timeline projection key is invalid: ${uri.fsPath}`);
    if (!isPlainObject(ref) || !hasOnlyKeys(ref, ['generation', 'file', 'checkpointHash', 'previousCheckpointHash', 'operationCount'])) {
      throw new Error(`Conversation timeline projection ref is invalid: ${uri.fsPath}`);
    }
    if (typeof ref.generation !== 'string' || !isSafeStorageGenerationId(ref.generation)) throw new Error(`Conversation timeline projection generation is invalid: ${uri.fsPath}`);
    if (ref.file !== timelineProjectionFile(ref.generation, projectionKey, chunkId)) throw new Error(`Conversation timeline projection file is invalid: ${uri.fsPath}`);
    if (typeof ref.checkpointHash !== 'string' || !ref.checkpointHash.trim()) throw new Error(`Conversation timeline projection hash is invalid: ${uri.fsPath}`);
    if (ref.previousCheckpointHash !== undefined && (typeof ref.previousCheckpointHash !== 'string' || !ref.previousCheckpointHash.trim())) {
      throw new Error(`Conversation timeline projection previous hash is invalid: ${uri.fsPath}`);
    }
    if (!isOptionalSafeNonNegativeInteger(ref.operationCount)) throw new Error(`Conversation timeline projection operation count is invalid: ${uri.fsPath}`);
    refs[projectionKey] = {
      generation: ref.generation,
      file: ref.file,
      checkpointHash: ref.checkpointHash,
      ...(ref.previousCheckpointHash !== undefined ? { previousCheckpointHash: ref.previousCheckpointHash } : {}),
      ...(ref.operationCount !== undefined ? { operationCount: ref.operationCount } : {})
    };
  }
  return refs;
}

function parseTimelineChunkFile(value: unknown, uri: vscode.Uri, record: ConversationTimelineChunkIndexRecord): ConversationTimelineChunkFile {
  const file = value as Partial<ConversationTimelineChunkFile> | undefined;
  assertTimelineFileBase(file, uri, 'conversationTimeline.chunk');
  if (!hasOnlyKeys(file, ['kind', 'schemaVersion', 'savedAt', 'generation', 'conversationId', 'chunkId', 'startSeq', 'endSeq', 'messageHash', 'messages'])) {
    throw new Error(`Conversation timeline chunk has unknown fields: ${uri.fsPath}`);
  }
  if (file.generation !== record.generation) throw new Error(`Conversation timeline chunk generation mismatch: ${uri.fsPath}`);
  if (file.chunkId !== record.id) throw new Error(`Conversation timeline chunk id mismatch: ${uri.fsPath}`);
  if (file.conversationId === undefined || typeof file.conversationId !== 'string' || !file.conversationId.trim()) throw new Error(`Conversation timeline chunk conversationId is invalid: ${uri.fsPath}`);
  if (file.startSeq !== record.startSeq || file.endSeq !== record.endSeq) throw new Error(`Conversation timeline chunk seq mismatch: ${uri.fsPath}`);
  if (file.messageHash !== record.messageHash) throw new Error(`Conversation timeline chunk message hash mismatch: ${uri.fsPath}`);
  if (!Array.isArray(file.messages)) throw new Error(`Conversation timeline chunk messages are invalid: ${uri.fsPath}`);
  return {
    kind: 'conversationTimeline.chunk',
    schemaVersion: STORAGE_VERSION,
    savedAt: file.savedAt,
    generation: record.generation,
    conversationId: file.conversationId,
    chunkId: record.id,
    startSeq: record.startSeq,
    endSeq: record.endSeq,
    messageHash: record.messageHash,
    messages: file.messages as MessageRecord[]
  };
}

function parseTimelineSidecarFile<TRecord>(
  value: unknown,
  uri: vscode.Uri,
  record: ConversationTimelineChunkIndexRecord,
  sidecarKey: TimelineSidecarKey,
  ref: TimelineSidecarRefRecord
): ConversationTimelineSidecarFile<TRecord> {
  const file = value as Partial<ConversationTimelineSidecarFile<TRecord>> | undefined;
  assertTimelineFileBase(file, uri, 'conversationTimeline.sidecar');
  if (!hasOnlyKeys(file, ['kind', 'schemaVersion', 'savedAt', 'generation', 'conversationId', 'chunkId', 'sidecarKey', 'sourceHash', 'count', 'records'])) {
    throw new Error(`Conversation timeline sidecar has unknown fields: ${uri.fsPath}`);
  }
  if (file.generation !== ref.generation || file.generation !== record.generation) throw new Error(`Conversation timeline sidecar generation mismatch: ${uri.fsPath}`);
  if (file.chunkId !== record.id || file.sidecarKey !== sidecarKey) throw new Error(`Conversation timeline sidecar identity mismatch: ${uri.fsPath}`);
  if (typeof file.conversationId !== 'string' || !file.conversationId.trim()) throw new Error(`Conversation timeline sidecar conversationId is invalid: ${uri.fsPath}`);
  if (file.sourceHash !== ref.sourceHash || file.count !== ref.count) throw new Error(`Conversation timeline sidecar ref mismatch: ${uri.fsPath}`);
  if (!Array.isArray(file.records)) throw new Error(`Conversation timeline sidecar records are invalid: ${uri.fsPath}`);
  return {
    kind: 'conversationTimeline.sidecar',
    schemaVersion: STORAGE_VERSION,
    savedAt: file.savedAt,
    generation: ref.generation,
    conversationId: file.conversationId,
    chunkId: record.id,
    sidecarKey,
    sourceHash: ref.sourceHash,
    count: ref.count,
    records: file.records as TRecord[]
  };
}

function parseTimelineProjectionFile(
  value: unknown,
  uri: vscode.Uri,
  record: ConversationTimelineChunkIndexRecord,
  projectionKey: string,
  ref: TimelineProjectionFileRefRecord
): TimelineProjectionCheckpointFile {
  const file = value as Partial<TimelineProjectionCheckpointFile> | undefined;
  assertTimelineFileBase(file, uri, 'conversationTimeline.projection');
  if (!hasOnlyKeys(file, [
    'kind',
    'schemaVersion',
    'savedAt',
    'generation',
    'conversationId',
    'chunkId',
    'projectionKey',
    'startSeq',
    'endSeq',
    'snapshotAfterChunk',
    'operationCount',
    'sourceHash',
    'checkpointHash',
    'previousCheckpointHash'
  ])) {
    throw new Error(`Conversation timeline projection has unknown fields: ${uri.fsPath}`);
  }
  if (file.generation !== ref.generation || file.generation !== record.generation) throw new Error(`Conversation timeline projection generation mismatch: ${uri.fsPath}`);
  if (file.chunkId !== record.id || file.projectionKey !== projectionKey) throw new Error(`Conversation timeline projection identity mismatch: ${uri.fsPath}`);
  if (typeof file.conversationId !== 'string' || !file.conversationId.trim()) throw new Error(`Conversation timeline projection conversationId is invalid: ${uri.fsPath}`);
  if (file.startSeq !== record.startSeq || file.endSeq !== record.endSeq) throw new Error(`Conversation timeline projection seq mismatch: ${uri.fsPath}`);
  if (file.sourceHash !== record.sourceHash || file.checkpointHash !== ref.checkpointHash) throw new Error(`Conversation timeline projection ref mismatch: ${uri.fsPath}`);
  const previousCheckpointHash = file.previousCheckpointHash;
  if (previousCheckpointHash !== undefined && (typeof previousCheckpointHash !== 'string' || !previousCheckpointHash.trim())) {
    throw new Error(`Conversation timeline projection previous hash is invalid: ${uri.fsPath}`);
  }
  if ((previousCheckpointHash ?? undefined) !== (ref.previousCheckpointHash ?? undefined)) throw new Error(`Conversation timeline projection previous hash mismatch: ${uri.fsPath}`);
  if (!isOptionalSafeNonNegativeInteger(file.operationCount) || (ref.operationCount ?? undefined) !== (file.operationCount ?? undefined)) {
    throw new Error(`Conversation timeline projection operation count mismatch: ${uri.fsPath}`);
  }
  return {
    kind: 'conversationTimeline.projection',
    schemaVersion: STORAGE_VERSION,
    savedAt: file.savedAt,
    generation: ref.generation,
    conversationId: file.conversationId,
    chunkId: record.id,
    projectionKey,
    startSeq: record.startSeq,
    endSeq: record.endSeq,
    snapshotAfterChunk: file.snapshotAfterChunk,
    ...(file.operationCount !== undefined ? { operationCount: file.operationCount } : {}),
    sourceHash: record.sourceHash,
    checkpointHash: ref.checkpointHash,
    ...(previousCheckpointHash !== undefined ? { previousCheckpointHash } : {})
  };
}

function assertTimelineFileBase<TKind extends TimelineFileKind>(value: unknown, uri: vscode.Uri, kind: TKind): asserts value is { kind: TKind; schemaVersion: typeof STORAGE_VERSION; savedAt: string; generation: string } & Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`Conversation timeline file must be an object: ${uri.fsPath}`);
  if (value.kind !== kind) throw new Error(`Conversation timeline file kind is invalid: ${uri.fsPath}`);
  if (value.schemaVersion !== STORAGE_VERSION) throw new Error(`Unsupported conversation timeline file schema: ${uri.fsPath}`);
  if (typeof value.savedAt !== 'string' || !value.savedAt.trim()) throw new Error(`Conversation timeline file savedAt is invalid: ${uri.fsPath}`);
  if (typeof value.generation !== 'string' || !isSafeStorageGenerationId(value.generation)) throw new Error(`Conversation timeline file generation is invalid: ${uri.fsPath}`);
}

function validateChunkRecordMetadata(record: ConversationTimelineChunkIndexRecord, chunk: ConversationTimelineChunkData, uri: vscode.Uri): void {
  const visibleMessages = chunk.messages.filter(isTimelineVisibleMessage);
  const seq = chunkDisplaySeqRange(chunk.messages);
  if (record.startSeq !== seq.startSeq || record.endSeq !== seq.endSeq) throw new Error(`Conversation timeline chunk seq metadata mismatch: ${uri.fsPath}`);
  if (record.messageCount !== visibleMessages.length) throw new Error(`Conversation timeline chunk messageCount mismatch: ${uri.fsPath}`);
  if (!arraysEqual(record.messageIds, chunk.messages.map((message) => message.id))) throw new Error(`Conversation timeline chunk messageIds mismatch: ${uri.fsPath}`);
  if (!arraysEqual(record.toolCallIds, chunk.toolCalls.map((toolCall) => toolCall.id))) throw new Error(`Conversation timeline chunk toolCallIds mismatch: ${uri.fsPath}`);
  if (record.toolCallCount !== chunk.toolCalls.length || record.toolCallEventCount !== chunk.toolCallEvents.length) throw new Error(`Conversation timeline chunk tool counts mismatch: ${uri.fsPath}`);
}

async function findExistingTimelineTraces(root: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(root);
    return entries.map(([name]) => name).filter((name) => name !== INDEX_FILE).sort();
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

async function findExistingTimelineTracesForUi(root: vscode.Uri): Promise<string[]> {
  try {
    return await findExistingTimelineTraces(root);
  } catch (error) {
    console.warn('[LimCode] Failed to inspect conversation timeline traces:', error);
    return ['unknown'];
  }
}

function conversationTimelineRoot(paths: StoragePaths, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.conversationsRootUri, CONVERSATION_DETAILS_DIR, safeShardName(conversationId), CONVERSATION_MESSAGES_DIR);
}

function timelineChunkFile(generation: string, chunkId: string): string {
  return `${STORAGE_GENERATIONS_DIR}/${generation}/${CONVERSATION_TIMELINE_CHUNKS_DIR}/${chunkId}.json`;
}

function timelineSidecarFile(generation: string, sidecarKey: TimelineSidecarKey, chunkId: string): string {
  return `${STORAGE_GENERATIONS_DIR}/${generation}/${CONVERSATION_TIMELINE_SIDECARS_DIR}/${sidecarKey}/${chunkId}.json`;
}

function timelineProjectionFile(generation: string, projectionKey: string, chunkId: string): string {
  return `${STORAGE_GENERATIONS_DIR}/${generation}/${CONVERSATION_TIMELINE_PROJECTIONS_DIR}/${safeProjectionKey(projectionKey)}/${chunkId}.json`;
}

function chunkDisplaySeqRange(messages: readonly MessageRecord[]): { startSeq: number; endSeq: number } {
  const visibleMessages = messages.filter(isTimelineVisibleMessage);
  const seqs = (visibleMessages.length > 0 ? visibleMessages : messages).map((message) => message.seq);
  return {
    startSeq: seqs.length > 0 ? Math.min(...seqs) : 0,
    endSeq: seqs.length > 0 ? Math.max(...seqs) : 0
  };
}

function isTimelineVisibleMessage(message: MessageRecord): boolean {
  return !message.content.parts.some(isFunctionResponsePart);
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
  state.checkpointTimelineAnchors.sort((left, right) => left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function uniqueById<TRecord extends { id: string }>(records: TRecord[]): TRecord[] {
  assertUniqueRecords(records, 'conversationTimeline.detail');
  return records;
}

function compareMessagesBySeq(left: MessageRecord, right: MessageRecord): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function compareToolCalls(left: ToolCallRecord, right: ToolCallRecord): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
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

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isOptionalSafeNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || isSafeNonNegativeInteger(value);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
