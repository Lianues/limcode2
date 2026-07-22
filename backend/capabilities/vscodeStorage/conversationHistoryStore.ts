import * as vscode from 'vscode';
import type {
  ConversationHistoryPageRecord,
  ConversationHistoryPageRequest,
  ConversationHistoryScope,
  ConversationOriginLinkRecord,
  SidebarConversationHistoryEntry
} from '../../../shared/protocol';
import {
  buildConversationHistoryForest,
  packConversationHistoryForestIntoPages,
  selectConversationOriginLinks
} from '../../../shared/conversationHistoryTree';
import { INDEX_FILE, STORAGE_VERSION } from './constants';
import { isFileNotFoundError, readJsonStrict, writeJson } from './json';
import type { StoragePaths } from './clientStateStore';
import { withStorageResourceLock } from './storageResourceLock';
import {
  cleanupInactiveStorageGenerations,
  createStorageGenerationLocation,
  isSafeStorageGenerationId,
  STORAGE_GENERATIONS_DIR
} from './storageGeneration';

const DEFAULT_PAGE_SIZE = 50;
const PAGES_DIR = 'pages';
const READER_MAX_ATTEMPTS = 3;

interface ConversationHistoryIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  generation: string;
  pageSize: number;
  total: number;
  pages: ConversationHistoryPageIndexRecord[];
}

interface ConversationHistoryPageIndexRecord {
  generation: string;
  file: string;
  count: number;
  newestUpdatedAt?: number;
  oldestUpdatedAt?: number;
}

interface ConversationHistoryPageFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  generation: string;
  entries: SidebarConversationHistoryEntry[];
  originLinks: ConversationOriginLinkRecord[];
}

interface ConversationHistoryCanonicalProjection {
  entries: SidebarConversationHistoryEntry[];
  originLinks: ConversationOriginLinkRecord[];
  generation?: string;
}

interface ConversationHistoryScopedProjection {
  entries: SidebarConversationHistoryEntry[];
  originLinks: ConversationOriginLinkRecord[];
}

interface ConversationHistoryIndexSnapshot {
  index: ConversationHistoryIndexFile;
  uri: vscode.Uri;
}

export interface ConversationHistoryStoreTestHookContext {
  rootUri: vscode.Uri;
  generation: string;
  attempt?: number;
}

export interface ConversationHistoryStoreTestHooks {
  /** 测试专用：页面完整写入后、根 index 原子发布前触发。抛错可模拟 index 发布失败。 */
  beforePublishIndex?: (context: ConversationHistoryStoreTestHookContext) => void | Promise<void>;
  /** 测试专用：reader 首次读取 index 后、读取 pages 前触发。可用于制造 generation 变化。 */
  afterReadIndexBeforePages?: (context: ConversationHistoryStoreTestHookContext) => void | Promise<void>;
}

export const __conversationHistoryStoreTestHooks: ConversationHistoryStoreTestHooks = {};

export async function loadConversationHistoryPageFromStore(
  paths: StoragePaths,
  request: ConversationHistoryPageRequest
): Promise<ConversationHistoryPageRecord> {
  const pageSize = normalizePageSize(request.limit);
  const canonical = await loadCanonicalProjectionForUi(paths);
  if (!canonical) return pageRecordFromScopedProjection(request, { entries: [], originLinks: [] }, pageSize);
  const scoped = deriveScopedProjection(canonical, request.scope);
  return pageRecordFromScopedProjection(request, scoped, pageSize);
}

export async function upsertConversationHistoryEntryInStore(
  paths: StoragePaths,
  entry: SidebarConversationHistoryEntry,
  originLink?: ConversationOriginLinkRecord
): Promise<void> {
  return mutateCanonicalProjection(paths, (projection) => {
    const index = projection.entries.findIndex((candidate) => candidate.id === entry.id);
    const nextEntry = { ...entry };
    if (index >= 0) projection.entries[index] = nextEntry;
    else projection.entries.push(nextEntry);

    projection.originLinks = projection.originLinks.filter((candidate) => candidate.conversationId !== entry.id);
    if (originLink?.conversationId === entry.id) projection.originLinks.push({ ...originLink });
  });
}

export async function removeConversationHistoryEntryFromStore(
  paths: StoragePaths,
  conversationId: string
): Promise<void> {
  return mutateCanonicalProjection(paths, (projection) => {
    const entryCount = projection.entries.length;
    const originLinkCount = projection.originLinks.length;
    projection.entries = projection.entries.filter((entry) => entry.id !== conversationId);
    projection.originLinks = projection.originLinks.filter((link) => link.conversationId !== conversationId);
    return projection.entries.length !== entryCount || projection.originLinks.length !== originLinkCount;
  });
}

async function mutateCanonicalProjection(
  paths: StoragePaths,
  mutate: (projection: ConversationHistoryCanonicalProjection) => boolean | void | Promise<boolean | void>
): Promise<void> {
  return withStorageResourceLock(paths.conversationHistoryRootUri, async () => {
    const projection = await loadCanonicalProjectionForWrite(paths);
    const previousGeneration = projection.generation;
    const changed = await mutate(projection);
    if (changed === false) return;
    await writeCanonicalProjection(paths, projection, previousGeneration);
  });
}

async function loadCanonicalProjectionForWrite(paths: StoragePaths): Promise<ConversationHistoryCanonicalProjection> {
  const indexUri = vscode.Uri.joinPath(paths.conversationHistoryRootUri, INDEX_FILE);
  const result = await readJsonStrict<unknown>(indexUri);
  if (result.status === 'missing') {
    const traces = await findExistingHistoryProjectionTraces(paths.conversationHistoryRootUri);
    if (traces.length) {
      throw new Error(`Conversation history index is missing but storage contains projection traces: ${traces.join(', ')}`);
    }
    return { entries: [], originLinks: [] };
  }
  if (result.status === 'invalid') {
    throw new Error(`Conversation history index JSON is invalid: ${indexUri.fsPath}`);
  }
  if (result.status === 'ioError') {
    throw new Error(`Failed to read conversation history index: ${indexUri.fsPath}`);
  }

  const snapshot = parseCanonicalIndex(result.value, indexUri);
  return loadProjectionFromIndex(paths.conversationHistoryRootUri, snapshot.index);
}

async function loadCanonicalProjectionForUi(paths: StoragePaths): Promise<ConversationHistoryCanonicalProjection | undefined> {
  const rootUri = paths.conversationHistoryRootUri;
  for (let attempt = 1; attempt <= READER_MAX_ATTEMPTS; attempt += 1) {
    const initial = await tryLoadCanonicalIndexForUi(rootUri);
    if (!initial) return undefined;

    await __conversationHistoryStoreTestHooks.afterReadIndexBeforePages?.({
      rootUri,
      generation: initial.index.generation,
      attempt
    });

    let projection: ConversationHistoryCanonicalProjection;
    try {
      projection = await loadProjectionFromIndex(rootUri, initial.index);
    } catch (error) {
      if (attempt < READER_MAX_ATTEMPTS && await indexGenerationChanged(rootUri, initial.index.generation)) continue;
      console.warn('[LimCode] Failed to load conversation history pages:', error);
      return undefined;
    }

    const confirmed = await tryLoadCanonicalIndexForUi(rootUri);
    if (!confirmed) return undefined;
    if (confirmed.index.generation === initial.index.generation) return projection;
  }

  console.warn('[LimCode] Conversation history generation changed while reading; giving up after limited retries.');
  return undefined;
}

async function tryLoadCanonicalIndexForUi(rootUri: vscode.Uri): Promise<ConversationHistoryIndexSnapshot | undefined> {
  const indexUri = vscode.Uri.joinPath(rootUri, INDEX_FILE);
  const result = await readJsonStrict<unknown>(indexUri);
  if (result.status === 'missing') {
    const traces = await findExistingHistoryProjectionTracesForUi(rootUri);
    if (traces.length) {
      console.warn(`[LimCode] Conversation history index is missing while projection traces exist: ${traces.join(', ')}`);
    }
    return undefined;
  }
  if (result.status === 'invalid') {
    console.warn(`[LimCode] Conversation history index JSON is invalid: ${indexUri.fsPath}`, result.error);
    return undefined;
  }
  if (result.status === 'ioError') {
    console.warn(`[LimCode] Failed to read conversation history index: ${indexUri.fsPath}`, result.error);
    return undefined;
  }

  try {
    return parseCanonicalIndex(result.value, indexUri);
  } catch (error) {
    console.warn('[LimCode] Conversation history index structure is invalid:', error);
    return undefined;
  }
}

async function indexGenerationChanged(rootUri: vscode.Uri, generation: string): Promise<boolean> {
  const current = await tryLoadCanonicalIndexForUi(rootUri);
  return !!current && current.index.generation !== generation;
}

async function loadProjectionFromIndex(
  rootUri: vscode.Uri,
  index: ConversationHistoryIndexFile
): Promise<ConversationHistoryCanonicalProjection> {
  const entries: SidebarConversationHistoryEntry[] = [];
  const originLinks: ConversationOriginLinkRecord[] = [];
  const seenEntryIds = new Set<string>();
  let totalFromPages = 0;

  for (const pageRecord of index.pages) {
    const pageUri = vscode.Uri.joinPath(rootUri, ...pageRecord.file.split('/'));
    const result = await readJsonStrict<unknown>(pageUri);
    if (result.status === 'missing') throw new Error(`Indexed conversation history page is missing: ${pageUri.fsPath}`);
    if (result.status === 'invalid') throw new Error(`Indexed conversation history page JSON is invalid: ${pageUri.fsPath}`);
    if (result.status === 'ioError') throw new Error(`Failed to read indexed conversation history page: ${pageUri.fsPath}`);

    const page = parseCanonicalPage(result.value, pageUri, index.generation, pageRecord);
    for (const entry of page.entries) {
      if (seenEntryIds.has(entry.id)) throw new Error(`Duplicate conversation history entry id in canonical projection: ${entry.id}`);
      seenEntryIds.add(entry.id);
      entries.push(entry);
    }
    originLinks.push(...page.originLinks);
    totalFromPages += page.entries.length;
  }

  if (totalFromPages !== index.total) {
    throw new Error(`Conversation history index total does not match pages: ${index.total} !== ${totalFromPages}`);
  }

  return { entries, originLinks, generation: index.generation };
}

async function writeCanonicalProjection(
  paths: StoragePaths,
  projection: ConversationHistoryCanonicalProjection,
  previousGeneration: string | undefined
): Promise<void> {
  const rootUri = paths.conversationHistoryRootUri;
  const savedAt = new Date().toISOString();
  const generation = createStorageGenerationLocation(rootUri);
  const pagesRoot = vscode.Uri.joinPath(generation.rootUri, PAGES_DIR);
  await vscode.workspace.fs.createDirectory(pagesRoot);

  const entries = uniqueById(projection.entries).map((entry) => ({ ...entry }));
  const entryIds = new Set(entries.map((entry) => entry.id));
  const originLinks = [...selectConversationOriginLinks(projection.originLinks).values()]
    .filter((link) => entryIds.has(link.conversationId))
    .map((link) => ({ ...link }));
  const forest = buildConversationHistoryForest(entries, originLinks);
  const pageGroups = packConversationHistoryForestIntoPages(forest, DEFAULT_PAGE_SIZE);
  const pages: ConversationHistoryPageIndexRecord[] = [];

  for (let pageIndex = 0; pageIndex < pageGroups.length; pageIndex += 1) {
    const nodes = pageGroups[pageIndex];
    const pageEntries = nodes.map((node) => ({ ...node.entry }));
    const pageOriginLinks = nodes
      .map((node) => node.originLink)
      .filter((link): link is ConversationOriginLinkRecord => link !== undefined)
      .map((link) => ({ ...link }));
    const file = canonicalPageFile(generation.id, pageIndex);
    await writeJson(vscode.Uri.joinPath(rootUri, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      generation: generation.id,
      entries: pageEntries,
      originLinks: pageOriginLinks
    } satisfies ConversationHistoryPageFile);

    pages.push({
      generation: generation.id,
      file,
      count: pageEntries.length,
      ...historyPageTimeRange(pageEntries)
    });
  }

  await __conversationHistoryStoreTestHooks.beforePublishIndex?.({ rootUri, generation: generation.id });

  await writeJson(vscode.Uri.joinPath(rootUri, INDEX_FILE), {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    generation: generation.id,
    pageSize: DEFAULT_PAGE_SIZE,
    total: entries.length,
    pages
  } satisfies ConversationHistoryIndexFile);

  await cleanupOldGenerationsAfterPublish(rootUri, generation.id, previousGeneration);
}

async function cleanupOldGenerationsAfterPublish(
  rootUri: vscode.Uri,
  currentGeneration: string,
  previousGeneration: string | undefined
): Promise<void> {
  try {
    const retained = new Set<string>([currentGeneration]);
    if (previousGeneration && isSafeStorageGenerationId(previousGeneration)) retained.add(previousGeneration);
    const result = await cleanupInactiveStorageGenerations(rootUri, retained);
    for (const failure of result.failed) {
      console.warn(`[LimCode] Failed to prune conversation history generation: ${failure.generation.id}`, failure.error);
    }
  } catch (error) {
    console.warn('[LimCode] Failed to prune inactive conversation history generations:', error);
  }
}

function pageRecordFromScopedProjection(
  request: ConversationHistoryPageRequest,
  projection: ConversationHistoryScopedProjection,
  pageSize: number
): ConversationHistoryPageRecord {
  const forest = buildConversationHistoryForest(projection.entries, projection.originLinks);
  const pageGroups = packConversationHistoryForestIntoPages(forest, pageSize);
  const requestedPageIndex = Math.max(0, Number.parseInt(request.cursor ?? '0', 10) || 0);
  const pageCount = Math.max(1, pageGroups.length);
  const pageIndex = Math.min(requestedPageIndex, pageCount - 1);
  const nodes = pageGroups[pageIndex] ?? [];
  const entries = nodes.map((node) => ({ ...node.entry }));
  const originLinks = nodes
    .map((node) => node.originLink)
    .filter((link): link is ConversationOriginLinkRecord => link !== undefined)
    .map((link) => ({ ...link }));

  return {
    scope: request.scope,
    entries,
    originLinks,
    pageInfo: {
      cursor: String(pageIndex),
      ...(pageIndex > 0 ? { previousCursor: String(pageIndex - 1) } : {}),
      ...(pageIndex + 1 < pageCount ? { nextCursor: String(pageIndex + 1) } : {}),
      pageIndex,
      pageSize,
      total: projection.entries.length,
      hasNext: pageIndex + 1 < pageCount,
      hasPrevious: pageIndex > 0
    }
  };
}

function deriveScopedProjection(
  projection: ConversationHistoryCanonicalProjection,
  scope: ConversationHistoryScope
): ConversationHistoryScopedProjection {
  const entries = projection.entries
    .filter((entry) => entryMatchesScope(entry, scope))
    .map((entry) => ({ ...entry }));
  const entryIds = new Set(entries.map((entry) => entry.id));
  const originLinks = [...selectConversationOriginLinks(projection.originLinks).values()]
    .filter((link) => entryIds.has(link.conversationId))
    .map((link) => ({ ...link }));
  return { entries, originLinks };
}

function entryMatchesScope(entry: SidebarConversationHistoryEntry, scope: ConversationHistoryScope): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'unbound') return !entry.projectFolderUri;
  return entry.projectFolderUri === scope.folderUri;
}

function parseCanonicalIndex(value: unknown, uri: vscode.Uri): ConversationHistoryIndexSnapshot {
  const index = value as Partial<ConversationHistoryIndexFile> | undefined;
  if (!isPlainObject(index)) throw new Error(`Conversation history index must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(index, ['schemaVersion', 'savedAt', 'generation', 'pageSize', 'total', 'pages'])) {
    throw new Error(`Conversation history index has unknown fields: ${uri.fsPath}`);
  }
  if (index.schemaVersion !== STORAGE_VERSION) throw new Error(`Unsupported conversation history index schema: ${uri.fsPath}`);
  if (typeof index.savedAt !== 'string' || !index.savedAt.trim()) throw new Error(`Conversation history index savedAt is invalid: ${uri.fsPath}`);
  if (typeof index.generation !== 'string' || !isSafeStorageGenerationId(index.generation)) {
    throw new Error(`Conversation history index generation is invalid: ${uri.fsPath}`);
  }
  const generation = index.generation;
  const pageSize = index.pageSize;
  if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error(`Conversation history index pageSize is invalid: ${uri.fsPath}`);
  }
  const total = index.total;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    throw new Error(`Conversation history index total is invalid: ${uri.fsPath}`);
  }
  if (!Array.isArray(index.pages)) throw new Error(`Conversation history index pages are invalid: ${uri.fsPath}`);
  const rawPages = index.pages;

  const pages: ConversationHistoryPageIndexRecord[] = [];
  let totalFromPageIndex = 0;
  for (let pageIndex = 0; pageIndex < rawPages.length; pageIndex += 1) {
    const page = rawPages[pageIndex] as Partial<ConversationHistoryPageIndexRecord> | undefined;
    if (!isPlainObject(page)) throw new Error(`Conversation history page index is invalid: ${uri.fsPath}`);
    if (!hasOnlyKeys(page, ['generation', 'file', 'count', 'newestUpdatedAt', 'oldestUpdatedAt'])) {
      throw new Error(`Conversation history page index has unknown fields: ${uri.fsPath}`);
    }
    const expectedFile = canonicalPageFile(generation, pageIndex);
    if (page.generation !== generation) throw new Error(`Conversation history page index generation mismatch: ${uri.fsPath}`);
    if (page.file !== expectedFile) throw new Error(`Conversation history page index file is invalid: ${uri.fsPath}`);
    const count = page.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Conversation history page index count is invalid: ${uri.fsPath}`);
    }
    if (!isOptionalFiniteNumber(page.newestUpdatedAt) || !isOptionalFiniteNumber(page.oldestUpdatedAt)) {
      throw new Error(`Conversation history page index time range is invalid: ${uri.fsPath}`);
    }
    totalFromPageIndex += count;
    pages.push({
      generation,
      file: page.file,
      count,
      ...(page.newestUpdatedAt !== undefined ? { newestUpdatedAt: page.newestUpdatedAt } : {}),
      ...(page.oldestUpdatedAt !== undefined ? { oldestUpdatedAt: page.oldestUpdatedAt } : {})
    });
  }
  if (totalFromPageIndex !== total) {
    throw new Error(`Conversation history index total does not match page counts: ${uri.fsPath}`);
  }

  return {
    uri,
    index: {
      schemaVersion: STORAGE_VERSION,
      savedAt: index.savedAt,
      generation,
      pageSize,
      total,
      pages
    }
  };
}

function parseCanonicalPage(
  value: unknown,
  uri: vscode.Uri,
  generation: string,
  pageRecord: ConversationHistoryPageIndexRecord
): ConversationHistoryPageFile {
  const page = value as Partial<ConversationHistoryPageFile> | undefined;
  if (!isPlainObject(page)) throw new Error(`Conversation history page must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(page, ['schemaVersion', 'savedAt', 'generation', 'entries', 'originLinks'])) {
    throw new Error(`Conversation history page has unknown fields: ${uri.fsPath}`);
  }
  if (page.schemaVersion !== STORAGE_VERSION) throw new Error(`Unsupported conversation history page schema: ${uri.fsPath}`);
  if (typeof page.savedAt !== 'string' || !page.savedAt.trim()) throw new Error(`Conversation history page savedAt is invalid: ${uri.fsPath}`);
  if (page.generation !== generation || page.generation !== pageRecord.generation) {
    throw new Error(`Conversation history page generation mismatch: ${uri.fsPath}`);
  }
  if (!Array.isArray(page.entries)) throw new Error(`Conversation history page entries are invalid: ${uri.fsPath}`);
  if (!Array.isArray(page.originLinks)) throw new Error(`Conversation history page originLinks are invalid: ${uri.fsPath}`);
  if (page.entries.length !== pageRecord.count) {
    throw new Error(`Conversation history page count mismatch: ${uri.fsPath}`);
  }

  const entries: SidebarConversationHistoryEntry[] = [];
  for (const entry of page.entries) {
    if (!isSidebarConversationHistoryEntry(entry)) throw new Error(`Conversation history page entry is invalid: ${uri.fsPath}`);
    entries.push({ ...entry });
  }
  const originLinks: ConversationOriginLinkRecord[] = [];
  for (const link of page.originLinks) {
    if (!isConversationOriginLinkRecord(link)) throw new Error(`Conversation history page origin link is invalid: ${uri.fsPath}`);
    originLinks.push({ ...link });
  }

  return {
    schemaVersion: STORAGE_VERSION,
    savedAt: page.savedAt,
    generation,
    entries,
    originLinks
  };
}

async function findExistingHistoryProjectionTraces(rootUri: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(rootUri);
    return entries.map(([name]) => name).sort();
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

async function findExistingHistoryProjectionTracesForUi(rootUri: vscode.Uri): Promise<string[]> {
  try {
    return await findExistingHistoryProjectionTraces(rootUri);
  } catch (error) {
    console.warn('[LimCode] Failed to inspect conversation history projection traces:', error);
    return ['unknown'];
  }
}

function canonicalPageFile(generation: string, pageIndex: number): string {
  return `${STORAGE_GENERATIONS_DIR}/${generation}/${PAGES_DIR}/${pageIndex.toString().padStart(6, '0')}.json`;
}

function normalizePageSize(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.floor(value));
}

function uniqueById(entries: SidebarConversationHistoryEntry[]): SidebarConversationHistoryEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSidebarConversationHistoryEntry(value: unknown): value is SidebarConversationHistoryEntry {
  const entry = value as Partial<SidebarConversationHistoryEntry> | undefined;
  return isPlainObject(entry)
    && typeof entry.id === 'string'
    && !!entry.id.trim()
    && typeof entry.title === 'string'
    && typeof entry.preview === 'string'
    && typeof entry.messageCount === 'number'
    && Number.isFinite(entry.messageCount)
    && entry.messageCount >= 0
    && typeof entry.status === 'string'
    && typeof entry.isRunning === 'boolean'
    && (entry.updatedAt === undefined || typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt))
    && (entry.agentName === undefined || typeof entry.agentName === 'string')
    && (entry.previewState === undefined || entry.previewState === 'pending' || entry.previewState === 'empty')
    && (entry.runStatus === undefined || typeof entry.runStatus === 'string')
    && (entry.runStatusLabel === undefined || typeof entry.runStatusLabel === 'string')
    && (entry.projectFolderUri === undefined || typeof entry.projectFolderUri === 'string')
    && (entry.projectName === undefined || typeof entry.projectName === 'string');
}

function isConversationOriginLinkRecord(value: unknown): value is ConversationOriginLinkRecord {
  const link = value as Partial<ConversationOriginLinkRecord> | undefined;
  return isPlainObject(link)
    && typeof link.id === 'string'
    && !!link.id.trim()
    && typeof link.conversationId === 'string'
    && !!link.conversationId.trim()
    && typeof link.originKind === 'string'
    && typeof link.createdAt === 'number'
    && Number.isFinite(link.createdAt)
    && typeof link.updatedAt === 'number'
    && Number.isFinite(link.updatedAt)
    && (link.sourceKind === undefined || typeof link.sourceKind === 'string')
    && (link.sourceAgentId === undefined || typeof link.sourceAgentId === 'string')
    && (link.sourceConversationId === undefined || typeof link.sourceConversationId === 'string')
    && (link.sourceMessageId === undefined || typeof link.sourceMessageId === 'string')
    && (link.sourceToolCallId === undefined || typeof link.sourceToolCallId === 'string')
    && (link.sourceRunId === undefined || typeof link.sourceRunId === 'string');
}

function historyPageTimeRange(entries: readonly SidebarConversationHistoryEntry[]): Pick<ConversationHistoryPageIndexRecord, 'newestUpdatedAt' | 'oldestUpdatedAt'> {
  let newestUpdatedAt: number | undefined;
  let oldestUpdatedAt: number | undefined;
  for (const entry of entries) {
    if (entry.updatedAt === undefined) continue;
    newestUpdatedAt = newestUpdatedAt === undefined ? entry.updatedAt : Math.max(newestUpdatedAt, entry.updatedAt);
    oldestUpdatedAt = oldestUpdatedAt === undefined ? entry.updatedAt : Math.min(oldestUpdatedAt, entry.updatedAt);
  }
  return newestUpdatedAt === undefined || oldestUpdatedAt === undefined
    ? {}
    : { newestUpdatedAt, oldestUpdatedAt };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}
