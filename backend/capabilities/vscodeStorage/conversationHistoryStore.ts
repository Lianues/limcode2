import * as vscode from 'vscode';
import type {
  ConversationHistoryPageRecord,
  ConversationHistoryPageRequest,
  ConversationHistoryScope,
  SidebarConversationHistoryEntry
} from '../../../shared/protocol';
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
}

interface ScopeFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  scope: ConversationHistoryScope;
}

export async function loadConversationHistoryPageFromStore(paths: StoragePaths, request: ConversationHistoryPageRequest): Promise<ConversationHistoryPageRecord> {
  const root = scopeRoot(paths, request.scope);
  const index = await readJson<ConversationHistoryScopeIndexFile>(vscode.Uri.joinPath(root, INDEX_FILE));
  const pageSize = normalizePageSize(index?.pageSize ?? request.limit);
  const requestedPageIndex = Math.max(0, Number.parseInt(request.cursor ?? '0', 10) || 0);
  const total = index?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageIndex = Math.min(requestedPageIndex, pageCount - 1);
  const pageRecord = index?.pages[pageIndex];
  const page = pageRecord ? await readJson<ConversationHistoryPageFile>(vscode.Uri.joinPath(root, ...pageRecord.file.split('/'))) : undefined;
  const entries = page?.schemaVersion === STORAGE_VERSION && sameScope(page.scope, request.scope) ? page.entries : [];

  return {
    scope: request.scope,
    entries,
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

export async function upsertConversationHistoryEntryInStore(paths: StoragePaths, entry: SidebarConversationHistoryEntry): Promise<void> {
  await removeConversationHistoryEntryFromStore(paths, entry.id);
  await upsertIntoScope(paths, { kind: 'all' }, entry);
  const scoped = entry.projectFolderUri ? { kind: 'project' as const, folderUri: entry.projectFolderUri } : { kind: 'unbound' as const };
  await upsertIntoScope(paths, scoped, entry);
}

export async function removeConversationHistoryEntryFromStore(paths: StoragePaths, conversationId: string): Promise<void> {
  const scopes = await existingScopes(paths);
  await Promise.all(scopes.map((scope) => removeFromScope(paths, scope, conversationId)));
}

async function upsertIntoScope(paths: StoragePaths, scope: ConversationHistoryScope, entry: SidebarConversationHistoryEntry): Promise<void> {
  const entries = await loadAllEntriesForScope(paths, scope);
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  const nextEntry = { ...entry };
  if (index >= 0) entries[index] = nextEntry;
  else entries.push(nextEntry);
  await writeScopeEntries(paths, scope, entries);
}

async function removeFromScope(paths: StoragePaths, scope: ConversationHistoryScope, conversationId: string): Promise<void> {
  const entries = await loadAllEntriesForScope(paths, scope);
  const next = entries.filter((entry) => entry.id !== conversationId);
  if (next.length === entries.length) return;
  await writeScopeEntries(paths, scope, next);
}

async function loadAllEntriesForScope(paths: StoragePaths, scope: ConversationHistoryScope): Promise<SidebarConversationHistoryEntry[]> {
  const root = scopeRoot(paths, scope);
  const index = await readJson<ConversationHistoryScopeIndexFile>(vscode.Uri.joinPath(root, INDEX_FILE));
  if (!index || index.schemaVersion !== STORAGE_VERSION || !sameScope(index.scope, scope)) return [];

  const result: SidebarConversationHistoryEntry[] = [];
  for (const page of index.pages) {
    const file = await readJson<ConversationHistoryPageFile>(vscode.Uri.joinPath(root, ...page.file.split('/')));
    if (file?.schemaVersion === STORAGE_VERSION && sameScope(file.scope, scope)) result.push(...file.entries);
  }
  return result;
}

async function writeScopeEntries(paths: StoragePaths, scope: ConversationHistoryScope, rawEntries: SidebarConversationHistoryEntry[]): Promise<void> {
  const savedAt = new Date().toISOString();
  const root = scopeRoot(paths, scope);
  const pagesRoot = vscode.Uri.joinPath(root, PAGES_DIR);
  await vscode.workspace.fs.createDirectory(pagesRoot);
  if (scope.kind === 'project') {
    await writeJson(vscode.Uri.joinPath(root, SCOPE_FILE), { schemaVersion: STORAGE_VERSION, savedAt, scope } satisfies ScopeFile);
  }

  const entries = uniqueById(rawEntries).sort(compareHistoryEntries);
  const pageSize = DEFAULT_PAGE_SIZE;
  const pages: ConversationHistoryPageIndexRecord[] = [];
  const pageCount = Math.ceil(entries.length / pageSize);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageEntries = entries.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const file = `${PAGES_DIR}/${pageIndex.toString().padStart(6, '0')}.json`;
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      scope,
      entries: pageEntries
    } satisfies ConversationHistoryPageFile);
    pages.push({
      file,
      count: pageEntries.length,
      ...(pageEntries[0]?.updatedAt !== undefined ? { newestUpdatedAt: pageEntries[0].updatedAt } : {}),
      ...(pageEntries[pageEntries.length - 1]?.updatedAt !== undefined ? { oldestUpdatedAt: pageEntries[pageEntries.length - 1].updatedAt } : {})
    });
  }

  await writeJson(vscode.Uri.joinPath(root, INDEX_FILE), {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    scope,
    pageSize,
    total: entries.length,
    pages
  } satisfies ConversationHistoryScopeIndexFile);
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

function compareHistoryEntries(left: SidebarConversationHistoryEntry, right: SidebarConversationHistoryEntry): number {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || left.title.localeCompare(right.title, 'zh-CN')
    || left.id.localeCompare(right.id, 'zh-CN');
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

