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
import { ensureStorageDirectory, readStorageDirectory } from './storageFs';
import {
  cleanupInactiveStorageGenerations,
  createStorageGenerationLocation,
  isSafeStorageGenerationId,
  listStorageGenerations,
  STORAGE_GENERATIONS_DIR
} from './storageGeneration';

const DEFAULT_PAGE_SIZE = 50;
const PAGES_DIR = 'pages';
const READER_MAX_ATTEMPTS = 3;
const HISTORY_PAGE_FILE_PATTERN = /^\d{6}\.json$/;

/**
 * 索引引用的页读不出来的原因。
 * - missing：文件不在了，页内容仍可能存在于其他 generation。
 * - invalid：文件在、但内容不是合法 JSON。掉电时 rename 的元数据先落盘、内容还在页缓存，
 *   重启后就会出现「文件存在、大小正确、内容全零」，这是本地实际发生过的事故形态。
 * - ioError：读取本身失败（权限、占用、坏道等）。
 */
type UnreadableIndexedHistoryPageReason = 'missing' | 'invalid' | 'ioError';

class UnreadableIndexedConversationHistoryPageError extends Error {
  public readonly pageUri: vscode.Uri;
  public readonly reason: UnreadableIndexedHistoryPageReason;

  public constructor(pageUri: vscode.Uri, reason: UnreadableIndexedHistoryPageReason) {
    super(
      reason === 'missing'
        ? `Indexed conversation history page is missing: ${pageUri.fsPath}`
        : `Indexed conversation history page is unreadable (${reason}): ${pageUri.fsPath}`
    );
    this.name = 'UnreadableIndexedConversationHistoryPageError';
    this.pageUri = pageUri;
    this.reason = reason;
  }
}

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
  if (result.status === 'ioError') {
    // 读取本身失败（文件被占用、句柄耗尽、瞬时坏道）时 index 内容很可能完好，重试就能读到。
    // 此时拿历史副本当写入基线会把这一代的增量永久删掉，所以维持 fail-closed 交给上层重试。
    throw new Error(`Failed to read conversation history index: ${indexUri.fsPath}`);
  }
  if (result.status === 'invalid') {
    // 内容已毁，重试无意义。此前这里直接抛错，导致写入永久瘫痪、侧边栏永久空白，
    // 且不留任何自愈机会。改为回退到保留期内的完整 generation 作为写入基线；连一份完整
    // 副本都找不到时才维持 fail-closed，避免把空数据发布成新一代、抹掉仍然完好的会话列表。
    const recovered = await loadLatestCompleteGenerationProjection(paths.conversationHistoryRootUri);
    if (recovered) {
      console.warn(`[LimCode] Conversation history index JSON is invalid; rebuilt write baseline from retained generation ${recovered.generation}: ${indexUri.fsPath}`);
      return recovered;
    }
    throw new Error(`Conversation history index JSON is invalid: ${indexUri.fsPath}`);
  }

  const snapshot = parseCanonicalIndex(result.value, indexUri);
  try {
    return await loadProjectionFromIndex(paths.conversationHistoryRootUri, snapshot.index);
  } catch (error) {
    if (!isUnreadableIndexedHistoryPageError(error)) throw error;
    // ioError 意味着页文件本身可能完好，只是这一刻读不到（杀软扫描、句柄耗尽等瞬时故障）。
    // 跳过它拼出来的基线会把本可以读回来的会话永久删掉，必须维持 fail-closed 交给重试。
    if (error.reason === 'ioError') throw error;
    // 缺页或内容损坏：用「保留副本 ∪ 当前 index 里还读得出来的页」合并出基线，恢复面最大。
    const recovered = await recoverProjectionAfterUnreadableIndexedPages(paths.conversationHistoryRootUri, snapshot.index);
    // 一条都恢复不出来时不能发布：空投影作为新一代会抹掉整份会话列表。
    if (recovered.entries.length === 0 && snapshot.index.total > 0) throw error;
    // 记下恢复前后的条目数：大面积损坏时（比如 6 页坏了 5 页）仍然会发布恢复结果，
    // 但日志里能直接看出丢了多少，而不是静默缩水。
    console.warn(`[LimCode] Conversation history page is ${error.reason}; rebuilt write baseline with ${recovered.entries.length} of ${snapshot.index.total} entries. ${formatErrorMessage(error)}`);
    return recovered;
  }
}

async function loadCanonicalProjectionForUi(paths: StoragePaths): Promise<ConversationHistoryCanonicalProjection | undefined> {
  const rootUri = paths.conversationHistoryRootUri;
  for (let attempt = 1; attempt <= READER_MAX_ATTEMPTS; attempt += 1) {
    const initial = await tryLoadCanonicalIndexForUi(rootUri);
    if (initial.kind === 'missing') return undefined;
    if (initial.kind === 'unreadable') {
      // 没有可用 index 时仍然可以直接扫保留期内的 generation：它们自带完整性校验
      // （页序连续 + JSON 可读 + entry id 不重），比让侧边栏直接空白好得多。
      const recovered = await loadLatestCompleteGenerationProjection(rootUri);
      if (recovered) {
        console.warn(`[LimCode] Conversation history index is unreadable; using retained generation ${recovered.generation} for UI.`);
        return recovered;
      }
      return undefined;
    }

    const initialIndex = initial.snapshot.index;
    await __conversationHistoryStoreTestHooks.afterReadIndexBeforePages?.({
      rootUri,
      generation: initialIndex.generation,
      attempt
    });

    let projection: ConversationHistoryCanonicalProjection;
    try {
      projection = await loadProjectionFromIndex(rootUri, initialIndex);
    } catch (error) {
      if (attempt < READER_MAX_ATTEMPTS && await indexGenerationChanged(rootUri, initialIndex.generation)) continue;
      if (isUnreadableIndexedHistoryPageError(error)) {
        console.warn(`[LimCode] Conversation history index references an unreadable page; using recovered projection for UI. ${formatErrorMessage(error)}`);
        return recoverProjectionAfterUnreadableIndexedPages(rootUri, initialIndex);
      }
      console.warn('[LimCode] Failed to load conversation history pages:', error);
      return undefined;
    }

    const confirmed = await tryLoadCanonicalIndexForUi(rootUri);
    if (confirmed.kind === 'missing') return undefined;
    // 确认读碰上 index 损坏时，projection 已经是从有效 index 完整读出来的，比丢掉它更安全。
    if (confirmed.kind === 'unreadable') return projection;
    if (confirmed.snapshot.index.generation === initialIndex.generation) return projection;
  }

  console.warn('[LimCode] Conversation history generation changed while reading; giving up after limited retries.');
  return undefined;
}

/**
 * UI 读取 index 的结果。必须区分 missing 与 unreadable：
 * missing 是首次安装的正常形态，unreadable 是损坏，后者应该去走恢复而不是直接返回空列表。
 */
type ConversationHistoryIndexReadResult =
  | { kind: 'ok'; snapshot: ConversationHistoryIndexSnapshot }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

async function tryLoadCanonicalIndexForUi(rootUri: vscode.Uri): Promise<ConversationHistoryIndexReadResult> {
  const indexUri = vscode.Uri.joinPath(rootUri, INDEX_FILE);
  const result = await readJsonStrict<unknown>(indexUri);
  if (result.status === 'missing') {
    const traces = await findExistingHistoryProjectionTracesForUi(rootUri);
    if (traces.length) {
      console.warn(`[LimCode] Conversation history index is missing while projection traces exist: ${traces.join(', ')}`);
      // 磁盘上还有投影遗迹，说明不是首次安装，而是 index 丢了，同样应该去走恢复。
      return { kind: 'unreadable' };
    }
    return { kind: 'missing' };
  }
  if (result.status === 'invalid') {
    console.warn(`[LimCode] Conversation history index JSON is invalid: ${indexUri.fsPath}`, result.error);
    return { kind: 'unreadable' };
  }
  if (result.status === 'ioError') {
    console.warn(`[LimCode] Failed to read conversation history index: ${indexUri.fsPath}`, result.error);
    return { kind: 'unreadable' };
  }

  try {
    return { kind: 'ok', snapshot: parseCanonicalIndex(result.value, indexUri) };
  } catch (error) {
    console.warn('[LimCode] Conversation history index structure is invalid:', error);
    return { kind: 'unreadable' };
  }
}

async function indexGenerationChanged(rootUri: vscode.Uri, generation: string): Promise<boolean> {
  const current = await tryLoadCanonicalIndexForUi(rootUri);
  return current.kind === 'ok' && current.snapshot.index.generation !== generation;
}

interface LoadProjectionFromIndexOptions {
  /**
   * salvage 模式：跳过所有读不出来的页，尽力拼出剩下的内容。
   * 只能用于恢复展示，结果绝不能当作写入基线（会永久丢失坏页里的会话）。
   */
  skipUnreadablePages?: boolean;
}

async function loadProjectionFromIndex(
  rootUri: vscode.Uri,
  index: ConversationHistoryIndexFile,
  options: LoadProjectionFromIndexOptions = {}
): Promise<ConversationHistoryCanonicalProjection> {
  const entries: SidebarConversationHistoryEntry[] = [];
  const originLinks: ConversationOriginLinkRecord[] = [];
  const seenEntryIds = new Set<string>();
  let totalFromPages = 0;

  for (const pageRecord of index.pages) {
    const pageUri = vscode.Uri.joinPath(rootUri, ...pageRecord.file.split('/'));
    const result = await readJsonStrict<unknown>(pageUri);
    if (result.status !== 'ok') {
      if (options.skipUnreadablePages) continue;
      throw new UnreadableIndexedConversationHistoryPageError(pageUri, result.status);
    }

    const page = parseCanonicalPage(result.value, pageUri, index.generation, pageRecord);
    for (const entry of page.entries) {
      if (seenEntryIds.has(entry.id)) throw new Error(`Duplicate conversation history entry id in canonical projection: ${entry.id}`);
      seenEntryIds.add(entry.id);
      entries.push(entry);
    }
    originLinks.push(...page.originLinks);
    totalFromPages += page.entries.length;
  }

  if (totalFromPages !== index.total && !options.skipUnreadablePages) {
    throw new Error(`Conversation history index total does not match pages: ${index.total} !== ${totalFromPages}`);
  }

  return { entries, originLinks, generation: index.generation };
}

async function recoverProjectionAfterUnreadableIndexedPages(
  rootUri: vscode.Uri,
  index: ConversationHistoryIndexFile
): Promise<ConversationHistoryCanonicalProjection> {
  const retained = await loadLatestCompleteGenerationProjection(rootUri, index.generation);
  const partial = await loadPartialProjectionFromIndex(rootUri, index);
  if (retained && partial) return mergeConversationHistoryProjections(retained, partial);
  if (retained) return retained;
  if (partial) return partial;
  return { entries: [], originLinks: [], generation: index.generation };
}

async function loadPartialProjectionFromIndex(
  rootUri: vscode.Uri,
  index: ConversationHistoryIndexFile
): Promise<ConversationHistoryCanonicalProjection | undefined> {
  try {
    const projection = await loadProjectionFromIndex(rootUri, index, { skipUnreadablePages: true });
    return projection.entries.length > 0 || projection.originLinks.length > 0 ? projection : undefined;
  } catch (error) {
    console.warn('[LimCode] Failed to salvage remaining conversation history pages from indexed generation:', error);
    return undefined;
  }
}

async function loadLatestCompleteGenerationProjection(
  rootUri: vscode.Uri,
  excludedGeneration?: string
): Promise<ConversationHistoryCanonicalProjection | undefined> {
  const generations = await listStorageGenerations(rootUri);
  for (const generation of generations.reverse()) {
    if (generation.id === excludedGeneration) continue;
    const projection = await tryLoadProjectionFromGenerationPages(rootUri, generation.id);
    if (projection) return projection;
  }
  return undefined;
}

async function tryLoadProjectionFromGenerationPages(
  rootUri: vscode.Uri,
  generation: string
): Promise<ConversationHistoryCanonicalProjection | undefined> {
  const pagesRoot = vscode.Uri.joinPath(rootUri, STORAGE_GENERATIONS_DIR, generation, PAGES_DIR);
  let directoryEntries: [string, vscode.FileType][];
  try {
    directoryEntries = await readStorageDirectory(pagesRoot);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }

  const files = directoryEntries
    .filter(([name, type]) => type === vscode.FileType.File && HISTORY_PAGE_FILE_PATTERN.test(name))
    .map(([name]) => name)
    .sort();
  if (files.length === 0) return undefined;
  for (let index = 0; index < files.length; index += 1) {
    if (files[index] !== `${index.toString().padStart(6, '0')}.json`) return undefined;
  }

  const entries: SidebarConversationHistoryEntry[] = [];
  const originLinks: ConversationOriginLinkRecord[] = [];
  const seenEntryIds = new Set<string>();
  try {
    for (const file of files) {
      const pageUri = vscode.Uri.joinPath(pagesRoot, file);
      const result = await readJsonStrict<unknown>(pageUri);
      if (result.status !== 'ok') return undefined;
      const page = parseStandaloneGenerationPage(result.value, pageUri, generation);
      for (const entry of page.entries) {
        if (seenEntryIds.has(entry.id)) return undefined;
        seenEntryIds.add(entry.id);
        entries.push(entry);
      }
      originLinks.push(...page.originLinks);
    }
  } catch (error) {
    console.warn(`[LimCode] Failed to read retained conversation history generation ${generation}:`, error);
    return undefined;
  }

  return { entries, originLinks, generation };
}

function mergeConversationHistoryProjections(
  base: ConversationHistoryCanonicalProjection,
  overlay: ConversationHistoryCanonicalProjection
): ConversationHistoryCanonicalProjection {
  const entriesById = new Map<string, SidebarConversationHistoryEntry>();
  for (const entry of base.entries) entriesById.set(entry.id, { ...entry });
  for (const entry of overlay.entries) entriesById.set(entry.id, { ...entry });
  const entryIds = new Set(entriesById.keys());
  return {
    entries: [...entriesById.values()],
    originLinks: [...base.originLinks, ...overlay.originLinks]
      .filter((link) => entryIds.has(link.conversationId))
      .map((link) => ({ ...link })),
    generation: base.generation ?? overlay.generation
  };
}

function isUnreadableIndexedHistoryPageError(error: unknown): error is UnreadableIndexedConversationHistoryPageError {
  return error instanceof UnreadableIndexedConversationHistoryPageError;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  await ensureStorageDirectory(pagesRoot);

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

function parseStandaloneGenerationPage(
  value: unknown,
  uri: vscode.Uri,
  generation: string
): ConversationHistoryPageFile {
  const page = value as Partial<ConversationHistoryPageFile> | undefined;
  if (!isPlainObject(page)) throw new Error(`Conversation history page must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(page, ['schemaVersion', 'savedAt', 'generation', 'entries', 'originLinks'])) {
    throw new Error(`Conversation history page has unknown fields: ${uri.fsPath}`);
  }
  if (page.schemaVersion !== STORAGE_VERSION) throw new Error(`Unsupported conversation history page schema: ${uri.fsPath}`);
  if (typeof page.savedAt !== 'string' || !page.savedAt.trim()) throw new Error(`Conversation history page savedAt is invalid: ${uri.fsPath}`);
  if (page.generation !== generation) throw new Error(`Conversation history page generation mismatch: ${uri.fsPath}`);
  if (!Array.isArray(page.entries)) throw new Error(`Conversation history page entries are invalid: ${uri.fsPath}`);
  if (!Array.isArray(page.originLinks)) throw new Error(`Conversation history page originLinks are invalid: ${uri.fsPath}`);

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
    const entries = await readStorageDirectory(rootUri);
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
