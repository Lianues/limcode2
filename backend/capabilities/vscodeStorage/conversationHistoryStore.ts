import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
import { readJson, writeJson } from './json';
import type { StoragePaths } from './clientStateStore';

const DEFAULT_PAGE_SIZE = 50;
const PAGES_DIR = 'pages';
const PROJECTS_DIR = 'projects';
const ALL_DIR = 'all';
const UNBOUND_DIR = 'unbound';
const SCOPE_FILE = 'scope.json';

interface ConversationHistoryScopeIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  scope: ConversationHistoryScope;
  pageSize: number;
  total: number;
  pages: ConversationHistoryPageIndexRecord[];
}

interface ConversationHistoryPageIndexRecord {
  file: string;
  count: number;
  newestUpdatedAt?: number;
  oldestUpdatedAt?: number;
}

interface ConversationHistoryPageFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  scope: ConversationHistoryScope;
  entries: SidebarConversationHistoryEntry[];
  originLinks: ConversationOriginLinkRecord[];
}

interface ConversationHistoryScopeProjection {
  entries: SidebarConversationHistoryEntry[];
  originLinks: ConversationOriginLinkRecord[];
  /** 旧格式数据将被整体重写时为 true：清理页文件会删除仍可人工恢复的旧数据，本次写入应跳过清理。 */
  supersededLegacy?: boolean;
}

interface ScopeFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  scope: ConversationHistoryScope;
}

export async function loadConversationHistoryPageFromStore(
  paths: StoragePaths,
  request: ConversationHistoryPageRequest
): Promise<ConversationHistoryPageRecord> {
  const root = scopeRoot(paths, request.scope);
  const storedIndex = await readJson<ConversationHistoryScopeIndexFile>(vscode.Uri.joinPath(root, INDEX_FILE));
  const index = storedIndex?.schemaVersion === STORAGE_VERSION
    && sameScope(storedIndex.scope, request.scope)
    && Array.isArray(storedIndex.pages)
    ? storedIndex
    : undefined;
  const pageSize = normalizePageSize(index?.pageSize ?? request.limit);
  const requestedPageIndex = Math.max(0, Number.parseInt(request.cursor ?? '0', 10) || 0);
  const total = index?.total ?? 0;
  // 会话树不能跨页拆分，因此页面条目数可能超过名义 pageSize；页面总数以索引为准。
  const pageCount = Math.max(1, index?.pages.length ?? 0);
  const pageIndex = Math.min(requestedPageIndex, pageCount - 1);
  const pageRecord = index?.pages[pageIndex];
  const page = pageRecord
    ? await readJson<ConversationHistoryPageFile>(vscode.Uri.joinPath(root, ...pageRecord.file.split('/')))
    : undefined;
  const validPage = page?.schemaVersion === STORAGE_VERSION
    && sameScope(page.scope, request.scope)
    && Array.isArray(page.entries)
    && Array.isArray(page.originLinks);
  const entries = validPage ? page.entries : [];
  const originLinks = validPage ? page.originLinks : [];

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
      total,
      hasNext: pageIndex + 1 < pageCount,
      hasPrevious: pageIndex > 0
    }
  };
}

export async function upsertConversationHistoryEntryInStore(
  paths: StoragePaths,
  entry: SidebarConversationHistoryEntry,
  originLink?: ConversationOriginLinkRecord
): Promise<void> {
  // 每个 scope 的投影都是“全量读 → 改 → 全量写”，且条目会跨 scope 迁移（removeFromStaleScopes），
  // 因此整个复合操作必须串行，否则并发 upsert（如同时创建多个子 Agent 会话）会互相覆盖丢条目。
  return withHistoryMutationLock(paths, async () => {
    const scoped = entry.projectFolderUri
      ? { kind: 'project' as const, folderUri: entry.projectFolderUri }
      : { kind: 'unbound' as const };
    const targetScopes: ConversationHistoryScope[] = [{ kind: 'all' }, scoped];
    await Promise.all(targetScopes.map((scope) => upsertIntoScope(paths, scope, entry, originLink)));
    await removeFromStaleScopes(paths, entry.id, targetScopes);
  });
}

export async function removeConversationHistoryEntryFromStore(
  paths: StoragePaths,
  conversationId: string
): Promise<void> {
  return withHistoryMutationLock(paths, async () => {
    const scopes = await existingScopes(paths);
    await Promise.all(scopes.map((scope) => removeFromScope(paths, scope, conversationId)));
  });
}

async function upsertIntoScope(
  paths: StoragePaths,
  scope: ConversationHistoryScope,
  entry: SidebarConversationHistoryEntry,
  originLink?: ConversationOriginLinkRecord
): Promise<void> {
  const projection = await loadScopeProjection(paths, scope, { strict: true });
  const index = projection.entries.findIndex((candidate) => candidate.id === entry.id);
  const nextEntry = { ...entry };
  if (index >= 0) projection.entries[index] = nextEntry;
  else projection.entries.push(nextEntry);

  projection.originLinks = projection.originLinks.filter((candidate) => candidate.conversationId !== entry.id);
  if (originLink?.conversationId === entry.id) projection.originLinks.push({ ...originLink });
  await writeScopeProjection(paths, scope, projection);
}

async function removeFromScope(
  paths: StoragePaths,
  scope: ConversationHistoryScope,
  conversationId: string
): Promise<void> {
  const projection = await loadScopeProjection(paths, scope, { strict: true });
  const entries = projection.entries.filter((entry) => entry.id !== conversationId);
  const originLinks = projection.originLinks.filter((link) => link.conversationId !== conversationId);
  if (entries.length === projection.entries.length && originLinks.length === projection.originLinks.length) return;
  await writeScopeProjection(paths, scope, { entries, originLinks });
}

async function removeFromStaleScopes(
  paths: StoragePaths,
  conversationId: string,
  targetScopes: ConversationHistoryScope[]
): Promise<void> {
  const scopes = await existingScopes(paths);
  const staleScopes = scopes.filter((scope) => !targetScopes.some((target) => sameScope(scope, target)));
  await Promise.all(staleScopes.map((scope) => removeFromScope(paths, scope, conversationId)));
}

async function loadScopeProjection(
  paths: StoragePaths,
  scope: ConversationHistoryScope,
  options: { strict?: boolean } = {}
): Promise<ConversationHistoryScopeProjection> {
  const root = scopeRoot(paths, scope);
  const indexUri = vscode.Uri.joinPath(root, INDEX_FILE);
  const index = await readJson<ConversationHistoryScopeIndexFile>(indexUri, { throwOnError: options.strict });
  // 文件不存在（新 scope）或旧版本格式（既有行为：下次写入时整体重写为新格式）都视为空投影。
  if (!index) {
    return { entries: [], originLinks: [] };
  }
  if (index.schemaVersion !== STORAGE_VERSION) {
    return { entries: [], originLinks: [], supersededLegacy: true };
  }
  if (!sameScope(index.scope, scope) || !Array.isArray(index.pages)) {
    // 当前版本但结构损坏：写路径必须中止，绝不能基于残缺投影回写并抹掉磁盘上完好的数据。
    if (options.strict) throw new Error(`Conversation history index is invalid: ${indexUri.fsPath}`);
    return { entries: [], originLinks: [] };
  }

  const entries: SidebarConversationHistoryEntry[] = [];
  const originLinks: ConversationOriginLinkRecord[] = [];
  for (const page of index.pages) {
    const fileUri = vscode.Uri.joinPath(root, ...page.file.split('/'));
    const file = await readJson<ConversationHistoryPageFile>(fileUri, { throwOnError: options.strict });
    const valid = file?.schemaVersion === STORAGE_VERSION
      && sameScope(file.scope, scope)
      && Array.isArray(file.entries)
      && Array.isArray(file.originLinks);
    if (valid) {
      entries.push(...file.entries);
      originLinks.push(...file.originLinks);
    } else if (options.strict) {
      throw new Error(`Indexed conversation history page is missing or invalid: ${fileUri.fsPath}`);
    }
  }
  return { entries, originLinks };
}

async function writeScopeProjection(
  paths: StoragePaths,
  scope: ConversationHistoryScope,
  projection: ConversationHistoryScopeProjection
): Promise<void> {
  const savedAt = new Date().toISOString();
  const root = scopeRoot(paths, scope);
  const pagesRoot = vscode.Uri.joinPath(root, PAGES_DIR);
  await vscode.workspace.fs.createDirectory(pagesRoot);
  if (scope.kind === 'project') {
    await writeJson(vscode.Uri.joinPath(root, SCOPE_FILE), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      scope
    } satisfies ScopeFile);
  }

  const entries = uniqueById(projection.entries);
  const entryIds = new Set(entries.map((entry) => entry.id));
  const originLinks = [...selectConversationOriginLinks(projection.originLinks).values()]
    .filter((link) => entryIds.has(link.conversationId));
  const forest = buildConversationHistoryForest(entries, originLinks);
  const pageGroups = packConversationHistoryForestIntoPages(forest, DEFAULT_PAGE_SIZE);
  const pages: ConversationHistoryPageIndexRecord[] = [];

  for (let pageIndex = 0; pageIndex < pageGroups.length; pageIndex += 1) {
    const nodes = pageGroups[pageIndex];
    const pageEntries = nodes.map((node) => node.entry);
    const pageOriginLinks = nodes
      .map((node) => node.originLink)
      .filter((link): link is ConversationOriginLinkRecord => link !== undefined);
    const file = `${PAGES_DIR}/${pageIndex.toString().padStart(6, '0')}.json`;
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      scope,
      entries: pageEntries,
      originLinks: pageOriginLinks
    } satisfies ConversationHistoryPageFile);

    pages.push({
      file,
      count: pageEntries.length,
      ...historyPageTimeRange(pageEntries)
    });
  }

  await writeJson(vscode.Uri.joinPath(root, INDEX_FILE), {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    scope,
    pageSize: DEFAULT_PAGE_SIZE,
    total: entries.length,
    pages
  } satisfies ConversationHistoryScopeIndexFile);

  // 先发布新索引，再清理不再被引用的旧页文件；读取者只会看到“旧索引 + 完整旧页”或“新索引 + 完整新页”。
  // 旧格式数据被整体重写时跳过清理：未被同名覆盖的旧页仍可用于人工恢复。
  if (!projection.supersededLegacy) {
    const referencedFiles = new Set(pages.map((page) => page.file));
    const existingPages = await listPageFiles(root);
    await Promise.all(existingPages
      .filter((file) => !referencedFiles.has(file))
      .map((file) => deletePageFile(root, file)));
  }
}

async function listPageFiles(root: vscode.Uri): Promise<string[]> {
  const pagesRoot = vscode.Uri.joinPath(root, PAGES_DIR);
  try {
    const entries = await vscode.workspace.fs.readDirectory(pagesRoot);
    return entries
      .filter(([, type]) => type === vscode.FileType.File)
      .map(([name]) => `${PAGES_DIR}/${name}`)
      .filter((file) => file.toLowerCase().endsWith('.json'))
      .sort();
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

async function deletePageFile(root: vscode.Uri, file: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, ...file.split('/')));
  } catch (error) {
    if (!isFileNotFound(error)) console.warn(`[LimCode] Failed to prune conversation history page: ${file}`, error);
  }
}

async function existingScopes(paths: StoragePaths): Promise<ConversationHistoryScope[]> {
  const scopes: ConversationHistoryScope[] = [{ kind: 'all' }, { kind: 'unbound' }];
  const projectsRoot = vscode.Uri.joinPath(paths.conversationHistoryRootUri, PROJECTS_DIR);
  try {
    const entries = await vscode.workspace.fs.readDirectory(projectsRoot);
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) continue;
      const scopeFile = await readJson<ScopeFile>(vscode.Uri.joinPath(projectsRoot, name, SCOPE_FILE));
      if (scopeFile?.schemaVersion === STORAGE_VERSION && scopeFile.scope.kind === 'project') scopes.push(scopeFile.scope);
    }
  } catch (error) {
    if (!isFileNotFound(error)) console.warn('[LimCode] Failed to scan conversation history project scopes:', error);
  }
  return scopes;
}

function scopeRoot(paths: StoragePaths, scope: ConversationHistoryScope): vscode.Uri {
  if (scope.kind === 'all') return vscode.Uri.joinPath(paths.conversationHistoryRootUri, ALL_DIR);
  if (scope.kind === 'unbound') return vscode.Uri.joinPath(paths.conversationHistoryRootUri, UNBOUND_DIR);
  return vscode.Uri.joinPath(paths.conversationHistoryRootUri, PROJECTS_DIR, safeScopeName(scope.folderUri));
}

function safeScopeName(folderUri: string): string {
  const name = projectNameFromUri(folderUri)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'project';
  return `${name}-${shortHash(folderUri)}`;
}

function projectNameFromUri(uri: string): string {
  try {
    const parsed = vscode.Uri.parse(uri);
    const path = parsed.fsPath || parsed.path || uri;
    const withoutTrailingSlash = path.replace(/[\\/]+$/g, '');
    return withoutTrailingSlash.split(/[\\/]/).pop()?.trim() || 'project';
  } catch {
    const withoutTrailingSlash = uri.replace(/[\\/]+$/g, '');
    return withoutTrailingSlash.split(/[\\/]/).pop()?.trim() || 'project';
  }
}

function normalizePageSize(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function uniqueById(entries: SidebarConversationHistoryEntry[]): SidebarConversationHistoryEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
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

function sameScope(left: ConversationHistoryScope, right: ConversationHistoryScope): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind !== 'project' || right.kind !== 'project' || left.folderUri === right.folderUri;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

// 与 recordStore.ts 相同的二级变更锁：进程内 promise 队列 + 跨进程 lockfile。
// all scope 被所有 VS Code 窗口共享，多窗口同时写同一 globalStorage 时也需要互斥。
const HISTORY_LOCK_STALE_MS = 30 * 60_000;
const HISTORY_LOCK_WAIT_MS = 5 * 60_000;
const HISTORY_LOCK_FILE = 'mutation.lock';
const historyMutationQueues = new Map<string, Promise<void>>();

async function withHistoryMutationLock<T>(paths: StoragePaths, action: () => Promise<T>): Promise<T> {
  // 注意：action 内不得再次调用本模块的公开写入口（upsert/removeConversationHistoryEntry…），否则会等待自己的 turn 造成自死锁。
  const key = paths.conversationHistoryRootUri.toString(true);
  const previous = historyMutationQueues.get(key) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const queue = previous.catch(() => undefined).then(() => turn);
  historyMutationQueues.set(key, queue);

  await previous.catch(() => undefined);
  try {
    return await withCrossProcessHistoryLock(paths.conversationHistoryRootUri, action);
  } finally {
    releaseTurn();
    if (historyMutationQueues.get(key) === queue) historyMutationQueues.delete(key);
  }
}

async function withCrossProcessHistoryLock<T>(rootUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
  if (rootUri.scheme !== 'file') return action();

  const lockPath = path.join(rootUri.fsPath, HISTORY_LOCK_FILE);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + HISTORY_LOCK_WAIT_MS;
  let handle: fs.FileHandle | undefined;

  while (!handle) {
    try {
      const candidate = await fs.open(lockPath, 'wx');
      try {
        await candidate.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
        handle = candidate;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (await removeStaleHistoryLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for conversation history lock: ${rootUri.fsPath}`);
      await delay(25);
    }
  }

  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function removeStaleHistoryLock(lockPath: string): Promise<boolean> {
  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(lockPath, 'utf8').catch(() => ''),
      fs.stat(lockPath)
    ]);
    const metadata = parseHistoryLockMetadata(raw);
    const pid = typeof metadata?.pid === 'number' && Number.isInteger(metadata.pid) ? metadata.pid : undefined;
    if (pid !== undefined && processIsAlive(pid)) return false;
    const createdAt = typeof metadata?.createdAt === 'number' && Number.isFinite(metadata.createdAt) ? metadata.createdAt : stat.mtimeMs;
    if (Date.now() - createdAt < HISTORY_LOCK_STALE_MS && pid === undefined) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return true;
    return false;
  }
}

function parseHistoryLockMetadata(raw: string): { pid?: unknown; createdAt?: unknown } | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'EEXIST';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface FileSystemLikeError {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  stack?: unknown;
}

function isFileNotFound(error: unknown): boolean {
  const candidate = error as FileSystemLikeError;
  const text = [candidate.name, candidate.code, candidate.message, candidate.stack, String(error)]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
  return /FileNotFound|EntryNotFound|ENOENT|ENOTDIR|not found|no such file|不存在|无法解析不存在的文件/i.test(text);
}
