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
import { createStorageRevision } from './storageRevision';
import {
  cleanupInactiveStorageGenerations,
  createStorageGenerationLocation,
  isSafeStorageGenerationId,
  listStorageGenerations,
  STANDARD_STORAGE_GENERATION_RETENTION_BUCKETS_MS,
  STORAGE_GENERATIONS_DIR
} from './storageGeneration';

const DEFAULT_PAGE_SIZE = 50;
const PAGES_DIR = 'pages';
const GENERATION_MANIFEST_FILE = 'manifest.json';
const GENERATION_COMMIT_FILE = 'committed.json';
const READER_MAX_ATTEMPTS = 3;

/**
 * 索引引用的页读不出来的原因。
 * - missing：文件不在了，页内容仍可能存在于其他 generation。
 * - invalid：文件在、但内容不是合法 JSON。掉电时 rename 的元数据先落盘、内容还在页缓存，
 *   重启后就会出现「文件存在、大小正确、内容全零」，这是本地实际发生过的事故形态。
 * - ioError：读取本身失败（权限、占用、坏道等）。
 */
type UnreadableIndexedHistoryPageReason = 'missing' | 'invalid' | 'ioError';

type ConversationHistoryIndexedResourceKind = 'index' | 'commit' | 'manifest' | 'page';

class UnreadableIndexedConversationHistoryResourceError extends Error {
  public readonly resourceKind: ConversationHistoryIndexedResourceKind;
  public readonly resourceUri: vscode.Uri;
  public readonly reason: UnreadableIndexedHistoryPageReason;

  public constructor(
    resourceKind: ConversationHistoryIndexedResourceKind,
    resourceUri: vscode.Uri,
    reason: UnreadableIndexedHistoryPageReason
  ) {
    const label = resourceKind === 'page' ? 'page' : resourceKind;
    super(
      reason === 'missing'
        ? `Indexed conversation history ${label} is missing: ${resourceUri.fsPath}`
        : `Indexed conversation history ${label} is unreadable (${reason}): ${resourceUri.fsPath}`
    );
    this.name = 'UnreadableIndexedConversationHistoryResourceError';
    this.resourceKind = resourceKind;
    this.resourceUri = resourceUri;
    this.reason = reason;
  }
}

interface ConversationHistoryIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  generation: string;
  manifestRevision: string;
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

interface ConversationHistoryGenerationManifestPayload {
  kind: 'conversationHistory.generation';
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  generation: string;
  /** 在 history root lock 内单调递增；恢复顺序不能依赖可能回拨的墙钟 generation id。 */
  commitSequence: number;
  pageSize: number;
  total: number;
  pages: ConversationHistoryPageIndexRecord[];
  entryIds: string[];
}

interface ConversationHistoryGenerationManifest extends ConversationHistoryGenerationManifestPayload {
  revision: string;
}

interface ConversationHistoryGenerationCommitFile {
  kind: 'conversationHistory.generationCommit';
  schemaVersion: typeof STORAGE_VERSION;
  generation: string;
  manifestRevision: string;
  committedAt: string;
  /** manifest 的冗余副本，避免 manifest.json 单点损坏让整代完好 pages 不可恢复。 */
  manifest: ConversationHistoryGenerationManifestPayload;
}

interface ConversationHistoryCanonicalProjection {
  entries: SidebarConversationHistoryEntry[];
  originLinks: ConversationOriginLinkRecord[];
  generation?: string;
  commitSequence?: number;
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
  /** 测试专用：覆盖下一代 generation id，用于模拟系统时钟回拨。 */
  createGenerationId?: () => string;
  /** 测试专用：页面完整写入后、根 index 原子发布前触发。抛错可模拟 index 发布失败。 */
  beforePublishIndex?: (context: ConversationHistoryStoreTestHookContext) => void | Promise<void>;
  /** 测试专用：根 index 已发布、committed marker 写入前触发。抛错可模拟提交点失败。 */
  beforeCommitGeneration?: (context: ConversationHistoryStoreTestHookContext) => void | Promise<void>;
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
  const rootUri = paths.conversationHistoryRootUri;
  const indexUri = vscode.Uri.joinPath(rootUri, INDEX_FILE);
  const result = await readJsonStrict<unknown>(indexUri);
  if (result.status === 'missing') {
    const traces = await findExistingHistoryProjectionTraces(rootUri);
    if (traces.length === 0) return { entries: [], originLinks: [] };
    const recovered = await loadLatestCommittedGenerationProjection(rootUri);
    if (recovered) {
      console.warn(`[LimCode] Conversation history index is missing; rebuilt write baseline from committed generation ${recovered.generation}: ${indexUri.fsPath}`);
      return recovered;
    }
    throw new Error(`Conversation history index is missing but storage contains no recoverable committed generation: ${traces.join(', ')}`);
  }
  if (result.status === 'ioError') {
    // 读取本身失败时 index 内容可能完好，必须 fail-closed 交给上层重试。
    throw new Error(`Failed to read conversation history index: ${indexUri.fsPath}`);
  }

  let snapshot: ConversationHistoryIndexSnapshot;
  try {
    if (result.status === 'invalid') throw result.error;
    snapshot = parseCanonicalIndex(result.value, indexUri);
  } catch (error) {
    const recovered = await loadLatestCommittedGenerationProjection(rootUri);
    if (recovered) {
      console.warn(`[LimCode] Conversation history index content is invalid; rebuilt write baseline from committed generation ${recovered.generation}: ${indexUri.fsPath}`, error);
      return recovered;
    }
    throw new Error(`Conversation history index content is invalid: ${indexUri.fsPath}`);
  }

  try {
    return await loadProjectionFromIndex(rootUri, snapshot.index);
  } catch (error) {
    if (!isUnreadableIndexedHistoryResourceError(error)) throw error;
    if (error.reason === 'ioError') throw error;
    const recovered = await recoverProjectionAfterUnreadableIndexedPages(rootUri, snapshot.index);
    if (recovered.entries.length === 0 && snapshot.index.total > 0) throw error;
    console.warn(`[LimCode] Conversation history ${error.resourceKind} is ${error.reason}; rebuilt write baseline with ${recovered.entries.length} of ${snapshot.index.total} entries. ${formatErrorMessage(error)}`);
    return recovered;
  }
}

async function loadCanonicalProjectionForUi(paths: StoragePaths): Promise<ConversationHistoryCanonicalProjection | undefined> {
  const rootUri = paths.conversationHistoryRootUri;
  for (let attempt = 1; attempt <= READER_MAX_ATTEMPTS; attempt += 1) {
    const initial = await tryLoadCanonicalIndexForUi(rootUri);
    if (initial.kind === 'missing') return undefined;
    if (initial.kind === 'unreadable') {
      // 没有可用 index 时只扫描带 committed marker 的 generation，并按 manifest 的精确页清单
      // 校验总数、revision 与 entry id；未提交或连续前缀残留不会进入恢复候选。
      const recovered = await loadLatestCommittedGenerationProjection(rootUri);
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
      if (isUnreadableIndexedHistoryResourceError(error)) {
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
   * 结果只能与已提交旧快照合并并按当前 manifest.entryIds 过滤，不能单独直接发布。
   */
  skipUnreadablePages?: boolean;
}

async function loadProjectionFromIndex(
  rootUri: vscode.Uri,
  index: ConversationHistoryIndexFile,
  options: LoadProjectionFromIndexOptions = {}
): Promise<ConversationHistoryCanonicalProjection> {
  const manifest = await loadIndexedGenerationManifest(rootUri, index);
  const entries: SidebarConversationHistoryEntry[] = [];
  const originLinks: ConversationOriginLinkRecord[] = [];
  const seenEntryIds = new Set<string>();
  let totalFromPages = 0;

  for (const pageRecord of index.pages) {
    const pageUri = vscode.Uri.joinPath(rootUri, ...pageRecord.file.split('/'));
    const result = await readJsonStrict<unknown>(pageUri);
    if (result.status !== 'ok') {
      if (options.skipUnreadablePages) continue;
      throw new UnreadableIndexedConversationHistoryResourceError('page', pageUri, result.status);
    }

    let page: ConversationHistoryPageFile;
    try {
      page = parseCanonicalPage(result.value, pageUri, index.generation, pageRecord);
      if (page.entries.some((entry) => seenEntryIds.has(entry.id))) {
        throw new Error(`Duplicate conversation history entry id in canonical projection: ${pageUri.fsPath}`);
      }
    } catch {
      if (options.skipUnreadablePages) continue;
      throw new UnreadableIndexedConversationHistoryResourceError('page', pageUri, 'invalid');
    }

    for (const entry of page.entries) {
      seenEntryIds.add(entry.id);
      entries.push(entry);
    }
    originLinks.push(...page.originLinks);
    totalFromPages += page.entries.length;
  }

  if (!options.skipUnreadablePages) {
    if (totalFromPages !== index.total || !sameStringSet(seenEntryIds, manifest.entryIds)) {
      throw new UnreadableIndexedConversationHistoryResourceError(
        'index',
        vscode.Uri.joinPath(rootUri, INDEX_FILE),
        'invalid'
      );
    }
  }

  return { entries, originLinks, generation: index.generation, commitSequence: manifest.commitSequence };
}

async function recoverProjectionAfterUnreadableIndexedPages(
  rootUri: vscode.Uri,
  index: ConversationHistoryIndexFile
): Promise<ConversationHistoryCanonicalProjection> {
  const retained = await loadLatestCommittedGenerationProjection(rootUri, index.generation);
  let manifest: ConversationHistoryGenerationManifest | undefined;
  try {
    manifest = await loadIndexedGenerationManifest(rootUri, index);
  } catch {
    // committed marker 本身损坏或丢失时无法证明当前 generation 已提交，只能回退到上一份已提交快照。
    return retained ?? { entries: [], originLinks: [], generation: index.generation };
  }

  const partial = await loadPartialProjectionFromIndex(rootUri, index);
  const merged = retained && partial
    ? mergeConversationHistoryProjections(retained, partial)
    : retained ?? partial ?? { entries: [], originLinks: [], generation: index.generation };
  // 当前 manifest 的 entryIds 是删除语义的唯一可信依据，防止旧快照中的已删除会话被复活。
  return filterProjectionToEntryIds(merged, manifest.entryIds, index.generation, manifest.commitSequence);
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

async function loadLatestCommittedGenerationProjection(
  rootUri: vscode.Uri,
  excludedGeneration?: string
): Promise<ConversationHistoryCanonicalProjection | undefined> {
  let latest: ConversationHistoryCanonicalProjection | undefined;
  for (const generation of await listStorageGenerations(rootUri)) {
    if (generation.id === excludedGeneration) continue;
    const projection = await tryLoadCommittedGenerationProjection(rootUri, generation.id);
    if (!projection) continue;
    if (!latest
      || (projection.commitSequence ?? 0) > (latest.commitSequence ?? 0)
      || (projection.commitSequence === latest.commitSequence
        && (projection.generation ?? '').localeCompare(latest.generation ?? '') > 0)) {
      latest = projection;
    }
  }
  return latest;
}

async function tryLoadCommittedGenerationProjection(
  rootUri: vscode.Uri,
  generation: string
): Promise<ConversationHistoryCanonicalProjection | undefined> {
  try {
    const commit = await tryLoadGenerationCommit(rootUri, generation);
    if (!commit) return undefined;
    const manifest = await resolveManifestFromCommit(rootUri, commit);

    const entries: SidebarConversationHistoryEntry[] = [];
    const originLinks: ConversationOriginLinkRecord[] = [];
    const seenEntryIds = new Set<string>();
    for (const pageRecord of manifest.pages) {
      const pageUri = vscode.Uri.joinPath(rootUri, ...pageRecord.file.split('/'));
      const result = await readJsonStrict<unknown>(pageUri);
      if (result.status !== 'ok') return undefined;
      const page = parseCanonicalPage(result.value, pageUri, generation, pageRecord);
      for (const entry of page.entries) {
        if (seenEntryIds.has(entry.id)) return undefined;
        seenEntryIds.add(entry.id);
        entries.push(entry);
      }
      originLinks.push(...page.originLinks);
    }
    if (entries.length !== manifest.total || !sameStringSet(seenEntryIds, manifest.entryIds)) return undefined;
    return { entries, originLinks, generation, commitSequence: manifest.commitSequence };
  } catch (error) {
    console.warn(`[LimCode] Failed to read committed conversation history generation ${generation}:`, error);
    return undefined;
  }
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
    generation: base.generation ?? overlay.generation,
    commitSequence: Math.max(base.commitSequence ?? 0, overlay.commitSequence ?? 0) || undefined
  };
}

function isUnreadableIndexedHistoryResourceError(error: unknown): error is UnreadableIndexedConversationHistoryResourceError {
  return error instanceof UnreadableIndexedConversationHistoryResourceError;
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
  const testGenerationId = __conversationHistoryStoreTestHooks.createGenerationId?.();
  const generation = testGenerationId
    ? createStorageGenerationLocation(rootUri, testGenerationId)
    : createStorageGenerationLocation(rootUri);
  const commitSequence = nextCommitSequence(projection.commitSequence);
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

  const manifestPayload: ConversationHistoryGenerationManifestPayload = {
    kind: 'conversationHistory.generation',
    schemaVersion: STORAGE_VERSION,
    savedAt,
    generation: generation.id,
    commitSequence,
    pageSize: DEFAULT_PAGE_SIZE,
    total: entries.length,
    pages,
    entryIds: [...entryIds].sort()
  };
  const manifestRevision = createStorageRevision(manifestPayload);
  await writeJson(generationManifestUri(rootUri, generation.id), {
    ...manifestPayload,
    revision: manifestRevision
  } satisfies ConversationHistoryGenerationManifest);

  await __conversationHistoryStoreTestHooks.beforePublishIndex?.({ rootUri, generation: generation.id });

  const index: ConversationHistoryIndexFile = {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    generation: generation.id,
    manifestRevision,
    pageSize: DEFAULT_PAGE_SIZE,
    total: entries.length,
    pages
  };
  await writeJson(vscode.Uri.joinPath(rootUri, INDEX_FILE), index);
  await __conversationHistoryStoreTestHooks.beforeCommitGeneration?.({ rootUri, generation: generation.id });

  // committed marker 是提交点：它在根 index 之后写入，并冗余携带 manifest。
  // marker 写失败时本次 mutation 必须报告失败；后续 reader 会把无 marker 的根 index 当作未提交并回退。
  await writeGenerationCommitMarker(rootUri, index, manifestPayload);
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
    const committedGenerationIds = await listCommittedGenerationIds(rootUri);
    const result = await cleanupInactiveStorageGenerations(rootUri, retained, {
      retentionBucketsMs: STANDARD_STORAGE_GENERATION_RETENTION_BUCKETS_MS,
      retentionEligibleGenerationIds: committedGenerationIds
    });
    for (const failure of result.failed) {
      console.warn(`[LimCode] Failed to prune conversation history generation: ${failure.generation.id}`, failure.error);
    }
  } catch (error) {
    console.warn('[LimCode] Failed to prune inactive conversation history generations:', error);
  }
}

async function loadIndexedGenerationManifest(
  rootUri: vscode.Uri,
  index: ConversationHistoryIndexFile
): Promise<ConversationHistoryGenerationManifest> {
  const commitUri = generationCommitUri(rootUri, index.generation);
  const commitResult = await readJsonStrict<unknown>(commitUri);
  if (commitResult.status !== 'ok') {
    // committed marker 是提交点；根 index 存在但 marker 缺失时，该 generation 仍属于未提交状态。
    throw new UnreadableIndexedConversationHistoryResourceError('commit', commitUri, commitResult.status);
  }

  try {
    const commit = parseGenerationCommit(commitResult.value, commitUri, index.generation);
    if (commit.manifestRevision !== index.manifestRevision) {
      throw new Error(`Conversation history index and commit mismatch: ${commitUri.fsPath}`);
    }
    const manifest = await resolveManifestFromCommit(rootUri, commit);
    assertManifestMatchesIndex(manifest, index, commitUri);
    return manifest;
  } catch (error) {
    if (isUnreadableIndexedHistoryResourceError(error)) throw error;
    throw new UnreadableIndexedConversationHistoryResourceError('commit', commitUri, 'invalid');
  }
}

async function tryLoadGenerationManifest(
  rootUri: vscode.Uri,
  generation: string
): Promise<ConversationHistoryGenerationManifest | undefined> {
  const uri = generationManifestUri(rootUri, generation);
  const result = await readJsonStrict<unknown>(uri);
  if (result.status !== 'ok') return undefined;
  try {
    return parseGenerationManifest(result.value, uri, generation);
  } catch {
    return undefined;
  }
}

async function tryLoadGenerationCommit(
  rootUri: vscode.Uri,
  generation: string
): Promise<ConversationHistoryGenerationCommitFile | undefined> {
  const uri = generationCommitUri(rootUri, generation);
  const result = await readJsonStrict<unknown>(uri);
  if (result.status !== 'ok') return undefined;
  try {
    return parseGenerationCommit(result.value, uri, generation);
  } catch {
    return undefined;
  }
}

async function resolveManifestFromCommit(
  rootUri: vscode.Uri,
  commit: ConversationHistoryGenerationCommitFile
): Promise<ConversationHistoryGenerationManifest> {
  const fileManifest = await tryLoadGenerationManifest(rootUri, commit.generation);
  if (fileManifest?.revision === commit.manifestRevision) return fileManifest;
  return { ...commit.manifest, revision: commit.manifestRevision };
}

function assertManifestMatchesIndex(
  manifest: ConversationHistoryGenerationManifest,
  index: ConversationHistoryIndexFile,
  uri: vscode.Uri
): void {
  if (manifest.revision !== index.manifestRevision
    || manifest.savedAt !== index.savedAt
    || manifest.pageSize !== index.pageSize
    || manifest.total !== index.total
    || createStorageRevision(manifest.pages) !== createStorageRevision(index.pages)) {
    throw new Error(`Conversation history index and committed manifest mismatch: ${uri.fsPath}`);
  }
}

async function writeGenerationCommitMarker(
  rootUri: vscode.Uri,
  index: ConversationHistoryIndexFile,
  manifest: ConversationHistoryGenerationManifestPayload
): Promise<void> {
  await writeJson(generationCommitUri(rootUri, index.generation), {
    kind: 'conversationHistory.generationCommit',
    schemaVersion: STORAGE_VERSION,
    generation: index.generation,
    manifestRevision: index.manifestRevision,
    committedAt: new Date().toISOString(),
    manifest
  } satisfies ConversationHistoryGenerationCommitFile);
}

async function listCommittedGenerationIds(rootUri: vscode.Uri): Promise<Set<string>> {
  const committed = new Set<string>();
  for (const generation of await listStorageGenerations(rootUri)) {
    const uri = generationCommitUri(rootUri, generation.id);
    const result = await readJsonStrict<unknown>(uri);
    if (result.status === 'ioError') throw result.error;
    if (result.status !== 'ok') continue;
    try {
      parseGenerationCommit(result.value, uri, generation.id);
      committed.add(generation.id);
    } catch {
      // missing/invalid marker 代表未提交或已损坏，不得占用 retention 时间桶。
    }
  }
  return committed;
}

function parseGenerationManifest(
  value: unknown,
  uri: vscode.Uri,
  expectedGeneration: string
): ConversationHistoryGenerationManifest {
  const manifest = value as Partial<ConversationHistoryGenerationManifest> | undefined;
  if (!isPlainObject(manifest)) throw new Error(`Conversation history generation manifest must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(manifest, ['kind', 'schemaVersion', 'savedAt', 'generation', 'commitSequence', 'pageSize', 'total', 'pages', 'entryIds', 'revision'])) {
    throw new Error(`Conversation history generation manifest has unknown fields: ${uri.fsPath}`);
  }
  if (manifest.kind !== 'conversationHistory.generation') throw new Error(`Conversation history generation manifest kind is invalid: ${uri.fsPath}`);
  if (manifest.generation !== expectedGeneration) throw new Error(`Conversation history generation manifest generation mismatch: ${uri.fsPath}`);
  if (typeof manifest.revision !== 'string' || !isStorageRevision(manifest.revision)) {
    throw new Error(`Conversation history generation manifest revision is invalid: ${uri.fsPath}`);
  }
  const commitSequence = manifest.commitSequence;
  if (!Number.isSafeInteger(commitSequence) || (commitSequence ?? 0) < 1) {
    throw new Error(`Conversation history generation manifest commitSequence is invalid: ${uri.fsPath}`);
  }
  if (!Array.isArray(manifest.entryIds)
    || manifest.entryIds.some((id) => typeof id !== 'string' || !id.trim())
    || new Set(manifest.entryIds).size !== manifest.entryIds.length) {
    throw new Error(`Conversation history generation manifest entryIds are invalid: ${uri.fsPath}`);
  }

  const normalized = parseCanonicalIndex({
    schemaVersion: manifest.schemaVersion,
    savedAt: manifest.savedAt,
    generation: manifest.generation,
    manifestRevision: manifest.revision,
    pageSize: manifest.pageSize,
    total: manifest.total,
    pages: manifest.pages
  }, uri).index;
  if (manifest.entryIds.length !== normalized.total) {
    throw new Error(`Conversation history generation manifest entryIds total mismatch: ${uri.fsPath}`);
  }
  const payload: ConversationHistoryGenerationManifestPayload = {
    kind: 'conversationHistory.generation',
    schemaVersion: STORAGE_VERSION,
    savedAt: normalized.savedAt,
    generation: normalized.generation,
    commitSequence: commitSequence!,
    pageSize: normalized.pageSize,
    total: normalized.total,
    pages: normalized.pages,
    entryIds: [...manifest.entryIds].sort()
  };
  if (createStorageRevision(payload) !== manifest.revision) {
    throw new Error(`Conversation history generation manifest revision mismatch: ${uri.fsPath}`);
  }
  return { ...payload, revision: manifest.revision };
}

function parseGenerationCommit(
  value: unknown,
  uri: vscode.Uri,
  expectedGeneration: string
): ConversationHistoryGenerationCommitFile {
  const commit = value as Partial<ConversationHistoryGenerationCommitFile> | undefined;
  if (!isPlainObject(commit)) throw new Error(`Conversation history generation commit must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(commit, ['kind', 'schemaVersion', 'generation', 'manifestRevision', 'committedAt', 'manifest'])) {
    throw new Error(`Conversation history generation commit has unknown fields: ${uri.fsPath}`);
  }
  if (commit.kind !== 'conversationHistory.generationCommit'
    || commit.schemaVersion !== STORAGE_VERSION
    || commit.generation !== expectedGeneration
    || typeof commit.manifestRevision !== 'string'
    || !isStorageRevision(commit.manifestRevision)
    || typeof commit.committedAt !== 'string'
    || !commit.committedAt.trim()
    || !isPlainObject(commit.manifest)) {
    throw new Error(`Conversation history generation commit is invalid: ${uri.fsPath}`);
  }
  const embedded = parseGenerationManifest({
    ...commit.manifest,
    revision: commit.manifestRevision
  }, uri, expectedGeneration);
  const { revision: _revision, ...manifest } = embedded;
  return {
    kind: 'conversationHistory.generationCommit',
    schemaVersion: STORAGE_VERSION,
    generation: expectedGeneration,
    manifestRevision: commit.manifestRevision,
    committedAt: commit.committedAt,
    manifest
  };
}

function filterProjectionToEntryIds(
  projection: ConversationHistoryCanonicalProjection,
  expectedEntryIds: readonly string[],
  generation: string,
  commitSequence: number
): ConversationHistoryCanonicalProjection {
  const expected = new Set(expectedEntryIds);
  const entries = projection.entries.filter((entry) => expected.has(entry.id)).map((entry) => ({ ...entry }));
  const recoveredIds = new Set(entries.map((entry) => entry.id));
  return {
    entries,
    originLinks: projection.originLinks
      .filter((link) => recoveredIds.has(link.conversationId))
      .map((link) => ({ ...link })),
    generation,
    commitSequence
  };
}

function nextCommitSequence(previous: number | undefined): number {
  const current = previous ?? 0;
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Conversation history commit sequence is invalid: ${String(previous)}`);
  }
  return current + 1;
}

function sameStringSet(actual: ReadonlySet<string>, expected: readonly string[]): boolean {
  if (actual.size !== expected.length) return false;
  return expected.every((value) => actual.has(value));
}

function isStorageRevision(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function generationManifestUri(rootUri: vscode.Uri, generation: string): vscode.Uri {
  return vscode.Uri.joinPath(rootUri, STORAGE_GENERATIONS_DIR, generation, GENERATION_MANIFEST_FILE);
}

function generationCommitUri(rootUri: vscode.Uri, generation: string): vscode.Uri {
  return vscode.Uri.joinPath(rootUri, STORAGE_GENERATIONS_DIR, generation, GENERATION_COMMIT_FILE);
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
  if (!hasOnlyKeys(index, ['schemaVersion', 'savedAt', 'generation', 'manifestRevision', 'pageSize', 'total', 'pages'])) {
    throw new Error(`Conversation history index has unknown fields: ${uri.fsPath}`);
  }
  if (index.schemaVersion !== STORAGE_VERSION) throw new Error(`Unsupported conversation history index schema: ${uri.fsPath}`);
  if (typeof index.savedAt !== 'string' || !index.savedAt.trim()) throw new Error(`Conversation history index savedAt is invalid: ${uri.fsPath}`);
  if (typeof index.generation !== 'string' || !isSafeStorageGenerationId(index.generation)) {
    throw new Error(`Conversation history index generation is invalid: ${uri.fsPath}`);
  }
  const generation = index.generation;
  const manifestRevision = index.manifestRevision;
  if (typeof manifestRevision !== 'string' || !isStorageRevision(manifestRevision)) {
    throw new Error(`Conversation history index manifestRevision is invalid: ${uri.fsPath}`);
  }
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
      manifestRevision,
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
