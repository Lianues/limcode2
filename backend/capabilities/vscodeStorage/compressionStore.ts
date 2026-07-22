import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ClientState, CompressionBlockLlmInvocationLinkRecord, CompressionBlockRecord, CompressionBlockSourceLinkRecord, CompressionContextVariantRecord, LlmInvocationRecord } from '../../../shared/protocol';
import { createEmptyClientState } from '../../../shared/clientStateSchema';
import { INDEX_FILE, STORAGE_VERSION } from './constants';
import type { StoragePaths } from './clientStateStore';
import { loadRecordStoreWithDiagnostics, saveRecordStore, withRecordStoreTransaction, type RecordStoreDiagnosticsResult } from './recordStore';
import { readJsonStrict, writeJson } from './json';
import { assertUniqueClientStateIds, assertUniqueRecords } from '../../utils/uniqueIds';

const CONVERSATIONS_DIR = 'conversations';
const COMPRESSION_MANIFEST_FILE = 'compression-manifest.json';
const COMPRESSION_MANIFEST_KIND = 'conversationCompression.manifest';

type CompressionStoreKey = 'blocks' | 'sourceLinks' | 'variants' | 'invocationLinks' | 'invocations';

type CompressionManifestState = 'writing' | 'committed';

interface CompressionStoreManifest {
  kind: typeof COMPRESSION_MANIFEST_KIND;
  schemaVersion: typeof STORAGE_VERSION;
  conversationId: string;
  state: CompressionManifestState;
  txId: string;
  startedAt: string;
  committedAt?: string;
  stores?: Partial<Record<CompressionStoreKey, { count: number }>>;
}

export interface CompressionStoreTestHooks {
  afterManifestWrite?: (manifest: CompressionStoreManifest) => void | Promise<void>;
  afterStoreSave?: (context: { conversationId: string; txId: string; store: CompressionStoreKey }) => void | Promise<void>;
}

export const __compressionStoreTestHooks: CompressionStoreTestHooks = {};
export interface LoadConversationCompressionDetailOptions {
  /**
   * 首屏 timeline 只需要压缩块和摘要变体用于展示，不需要“压缩块 -> 源消息”的明细链接。
   * 这些 source links 可能非常多，默认仍加载以满足后端 hydrate / 编辑删除 / 失效判断。
   */
  includeSourceLinks?: boolean;
  /**
   * 完整 timeline 已加载时传入全量 message id，可安全恢复仍有源消息的 orphan compression record。
   */
  knownMessageIds?: ReadonlySet<string>;
  recoverOrphanRecords?: boolean;
}

export async function loadConversationCompressionDetail(
  paths: StoragePaths,
  conversationId: string,
  options: LoadConversationCompressionDetailOptions = {}
): Promise<ClientState | undefined> {
  return withRecordStoreTransaction(compressionTransactionUri(paths, conversationId), () => loadConversationCompressionDetailUnlocked(paths, conversationId, options));
}

async function loadConversationCompressionDetailUnlocked(
  paths: StoragePaths,
  conversationId: string,
  options: LoadConversationCompressionDetailOptions = {}
): Promise<ClientState | undefined> {
  await assertCommittedCompressionSnapshot(paths, conversationId);
  const includeSourceLinks = options.includeSourceLinks ?? true;
  const recoverOrphanRecords = options.recoverOrphanRecords ?? options.knownMessageIds !== undefined;
  const state = createEmptyClientState();
  const now = Date.now();
  const blockStore = conversationScopedStore(paths.compressionBlocksRootUri, conversationId);
  const sourceLinkStore = conversationScopedStore(paths.compressionBlockSourceLinksRootUri, conversationId);
  const variantStore = conversationScopedStore(paths.compressionContextVariantsRootUri, conversationId);
  const invocationLinkStore = conversationScopedStore(paths.compressionBlockLlmInvocationLinksRootUri, conversationId);
  const invocationStore = conversationScopedStore(paths.compressionLlmInvocationsRootUri, conversationId);

  const blockDiag = await loadRecordStoreWithDiagnostics<CompressionBlockRecord, 'block'>(blockStore.root, blockStore.index, 'block');
  const sourceLinkDiag = includeSourceLinks || recoverOrphanRecords
    ? await loadRecordStoreWithDiagnostics<CompressionBlockSourceLinkRecord, 'link'>(sourceLinkStore.root, sourceLinkStore.index, 'link')
    : emptyDiagnostics<CompressionBlockSourceLinkRecord>();
  const variantDiag = await loadRecordStoreWithDiagnostics<CompressionContextVariantRecord, 'variant'>(variantStore.root, variantStore.index, 'variant');

  const indexedBlockIds = new Set(blockDiag.indexedIds);
  const sourceLinksByBlock = groupBy(sourceLinkDiag.records, (link) => link.blockId);
  const variantsByBlock = groupBy(variantDiag.records, (variant) => variant.blockId);
  const indexedBlocks = blockDiag.records
    .filter((block) => indexedBlockIds.has(block.id) && block.conversationId === conversationId)
    .map((block) => normalizeLoadedCompressionBlock(block, now));
  const latestIndexedCompleteSeq = Math.max(
    -1,
    ...indexedBlocks
      .filter((block) => block.status === 'complete')
      .map((block) => block.anchorSeq ?? block.endSeq ?? -1)
  );
  state.compressionBlocks = blockDiag.records
    .filter((block) => block.conversationId === conversationId)
    .map((block) => normalizeLoadedCompressionBlock(block, now))
    .filter((block) => {
      if (indexedBlockIds.has(block.id)) return true;
      if (!recoverOrphanRecords) return false;
      const decision = shouldRecoverOrphanCompressionBlock(block, {
        latestIndexedCompleteSeq,
        sourceLinks: sourceLinksByBlock.get(block.id) ?? [],
        variants: variantsByBlock.get(block.id) ?? [],
        knownMessageIds: options.knownMessageIds
      });
      if (!decision.recover) return false;
      return true;
    });
  const blockIds = new Set(state.compressionBlocks.map((block) => block.id));

  if (includeSourceLinks) {
    state.compressionBlockSourceLinks = sourceLinkDiag.records.filter((link) => blockIds.has(link.blockId));
  }

  state.compressionContextVariants = variantDiag.records.filter((variant) => blockIds.has(variant.blockId));

  const invocationLinkDiag = await loadRecordStoreWithDiagnostics<CompressionBlockLlmInvocationLinkRecord, 'link'>(invocationLinkStore.root, invocationLinkStore.index, 'link');
  state.compressionBlockLlmInvocationLinks = invocationLinkDiag.records.filter((link) => blockIds.has(link.blockId));

  const invocationIds = new Set(state.compressionBlockLlmInvocationLinks.map((link) => link.invocationId));
  const invocationDiag = await loadRecordStoreWithDiagnostics<LlmInvocationRecord, 'invocation'>(invocationStore.root, invocationStore.index, 'invocation');
  state.llmInvocations = invocationDiag.records.filter((invocation) => invocationIds.has(invocation.id)).map((invocation) => normalizeLoadedLlmInvocation(invocation, now));

  const hasCompression = state.compressionBlocks.length || state.compressionBlockSourceLinks.length || state.compressionContextVariants.length || state.compressionBlockLlmInvocationLinks.length || state.llmInvocations.length;
  assertUniqueClientStateIds(state, `compressionDetail:${conversationId}`);
  return hasCompression ? state : undefined;
}

export async function saveConversationCompressionDetail(paths: StoragePaths, conversationId: string, state: ClientState): Promise<void> {
  assertUniqueClientStateIds(state, `saveCompressionDetail:${conversationId}:source`);
  return withRecordStoreTransaction(compressionTransactionUri(paths, conversationId), () => saveConversationCompressionDetailUnlocked(paths, conversationId, state));
}

async function saveConversationCompressionDetailUnlocked(paths: StoragePaths, conversationId: string, state: ClientState): Promise<void> {
  const txId = randomUUID();
  const startedAt = new Date().toISOString();
  await writeCompressionManifest(paths, conversationId, { state: 'writing', txId, startedAt });

  const blocks = state.compressionBlocks.filter((block) => block.conversationId === conversationId);
  const blockIds = new Set(blocks.map((block) => block.id));
  let links = state.compressionBlockSourceLinks.filter((link) => blockIds.has(link.blockId));
  let variants = state.compressionContextVariants.filter((variant) => blockIds.has(variant.blockId));
  let invocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => blockIds.has(link.blockId));
  let invocationIds = new Set(invocationLinks.map((link) => link.invocationId));
  let invocations = state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id));
  const existingSourceLinkStore = conversationScopedStore(paths.compressionBlockSourceLinksRootUri, conversationId);
  const existingVariantStore = conversationScopedStore(paths.compressionContextVariantsRootUri, conversationId);
  const existingInvocationLinkStore = conversationScopedStore(paths.compressionBlockLlmInvocationLinksRootUri, conversationId);
  const existingInvocationStore = conversationScopedStore(paths.compressionLlmInvocationsRootUri, conversationId);
  const [existingSourceLinks, existingVariants, existingInvocationLinks, existingInvocations] = await Promise.all([
    loadRecordStoreWithDiagnostics<CompressionBlockSourceLinkRecord, 'link'>(existingSourceLinkStore.root, existingSourceLinkStore.index, 'link'),
    loadRecordStoreWithDiagnostics<CompressionContextVariantRecord, 'variant'>(existingVariantStore.root, existingVariantStore.index, 'variant'),
    loadRecordStoreWithDiagnostics<CompressionBlockLlmInvocationLinkRecord, 'link'>(existingInvocationLinkStore.root, existingInvocationLinkStore.index, 'link'),
    loadRecordStoreWithDiagnostics<LlmInvocationRecord, 'invocation'>(existingInvocationStore.root, existingInvocationStore.index, 'invocation')
  ]);

  links = mergeRecordsById(existingSourceLinks.records.filter((link) => blockIds.has(link.blockId)), links);
  variants = mergeRecordsById(existingVariants.records.filter((variant) => blockIds.has(variant.blockId)), variants);
  invocationLinks = mergeRecordsById(existingInvocationLinks.records.filter((link) => blockIds.has(link.blockId)), invocationLinks);
  invocationIds = new Set(invocationLinks.map((link) => link.invocationId));
  invocations = mergeRecordsById(existingInvocations.records.filter((invocation) => invocationIds.has(invocation.id)), invocations.filter((invocation) => invocationIds.has(invocation.id)));

  await saveCompressionRecordStore(paths.compressionBlocksRootUri, conversationId, blocks, 'block', 'blocks', txId, (record) => record.title || record.id);
  await saveCompressionRecordStore(paths.compressionBlockSourceLinksRootUri, conversationId, links, 'link', 'sourceLinks', txId, (record) => record.id);
  await saveCompressionRecordStore(paths.compressionContextVariantsRootUri, conversationId, variants, 'variant', 'variants', txId, (record) => record.id);
  await saveCompressionRecordStore(paths.compressionBlockLlmInvocationLinksRootUri, conversationId, invocationLinks, 'link', 'invocationLinks', txId, (record) => record.id);
  await saveCompressionRecordStore(paths.compressionLlmInvocationsRootUri, conversationId, invocations, 'invocation', 'invocations', txId, (record) => record.id);

  await writeCompressionManifest(paths, conversationId, {
    state: 'committed',
    txId,
    startedAt,
    committedAt: new Date().toISOString(),
    stores: {
      blocks: { count: blocks.length },
      sourceLinks: { count: links.length },
      variants: { count: variants.length },
      invocationLinks: { count: invocationLinks.length },
      invocations: { count: invocations.length }
    }
  });
}

async function saveCompressionRecordStore<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  conversationId: string,
  records: TRecord[],
  recordKey: TKey,
  store: CompressionStoreKey,
  txId: string,
  labelForRecord: (record: TRecord) => string
): Promise<void> {
  await saveRecordStore(conversationScopedRoot(root, conversationId), conversationScopedIndex(root, conversationId), records, recordKey, labelForRecord, { pruneMissing: true });
  await __compressionStoreTestHooks.afterStoreSave?.({ conversationId, txId, store });
}

async function writeCompressionManifest(
  paths: StoragePaths,
  conversationId: string,
  input: {
    state: CompressionManifestState;
    txId: string;
    startedAt: string;
    committedAt?: string;
    stores?: Partial<Record<CompressionStoreKey, { count: number }>>;
  }
): Promise<void> {
  const manifest: CompressionStoreManifest = {
    kind: COMPRESSION_MANIFEST_KIND,
    schemaVersion: STORAGE_VERSION,
    conversationId,
    state: input.state,
    txId: input.txId,
    startedAt: input.startedAt,
    ...(input.committedAt ? { committedAt: input.committedAt } : {}),
    ...(input.stores ? { stores: input.stores } : {})
  };
  await writeJson(compressionManifestUri(paths, conversationId), manifest);
  await __compressionStoreTestHooks.afterManifestWrite?.(manifest);
}

async function assertCommittedCompressionSnapshot(paths: StoragePaths, conversationId: string): Promise<void> {
  const manifest = await readCompressionManifest(paths, conversationId);
  if (!manifest) {
    const traces = await findCompressionStoreTraces(paths, conversationId);
    if (traces.length === 0) return;
    throw new Error(`Compression snapshot manifest is missing for ${conversationId}, but store traces exist: ${traces.join(', ')}`);
  }
  if (manifest.state !== 'committed') {
    throw new Error(`Compression snapshot is not committed for ${conversationId}: state=${manifest.state}, txId=${manifest.txId}`);
  }
}

async function readCompressionManifest(paths: StoragePaths, conversationId: string): Promise<CompressionStoreManifest | undefined> {
  const uri = compressionManifestUri(paths, conversationId);
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') return undefined;
  if (result.status === 'invalid') throw new Error(`Compression manifest JSON is invalid: ${uri.fsPath}`);
  if (result.status === 'ioError') throw new Error(`Failed to read compression manifest: ${uri.fsPath}`);
  return parseCompressionManifest(result.value, uri, conversationId);
}

function parseCompressionManifest(value: unknown, uri: vscode.Uri, conversationId: string): CompressionStoreManifest {
  const manifest = value as Partial<CompressionStoreManifest> | undefined;
  if (!manifest || typeof manifest !== 'object') throw new Error(`Compression manifest must be an object: ${uri.fsPath}`);
  if (manifest.kind !== COMPRESSION_MANIFEST_KIND) throw new Error(`Compression manifest kind is invalid: ${uri.fsPath}`);
  if (manifest.schemaVersion !== STORAGE_VERSION) throw new Error(`Unsupported compression manifest schema: ${uri.fsPath}`);
  if (manifest.conversationId !== conversationId) throw new Error(`Compression manifest conversation mismatch: ${uri.fsPath}`);
  if (manifest.state !== 'writing' && manifest.state !== 'committed') throw new Error(`Compression manifest state is invalid: ${uri.fsPath}`);
  if (typeof manifest.txId !== 'string' || !manifest.txId.trim()) throw new Error(`Compression manifest txId is invalid: ${uri.fsPath}`);
  if (typeof manifest.startedAt !== 'string' || !manifest.startedAt.trim()) throw new Error(`Compression manifest startedAt is invalid: ${uri.fsPath}`);
  if (manifest.committedAt !== undefined && (typeof manifest.committedAt !== 'string' || !manifest.committedAt.trim())) throw new Error(`Compression manifest committedAt is invalid: ${uri.fsPath}`);
  return {
    kind: COMPRESSION_MANIFEST_KIND,
    schemaVersion: STORAGE_VERSION,
    conversationId,
    state: manifest.state,
    txId: manifest.txId,
    startedAt: manifest.startedAt,
    ...(manifest.committedAt ? { committedAt: manifest.committedAt } : {}),
    ...(isCompressionManifestStores(manifest.stores) ? { stores: manifest.stores } : {})
  };
}

function isCompressionManifestStores(value: unknown): value is Partial<Record<CompressionStoreKey, { count: number }>> {
  if (value === undefined) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!['blocks', 'sourceLinks', 'variants', 'invocationLinks', 'invocations'].includes(key)) return false;
    const count = (item as { count?: unknown } | undefined)?.count;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  });
}

async function findCompressionStoreTraces(paths: StoragePaths, conversationId: string): Promise<string[]> {
  const roots: Array<[CompressionStoreKey, vscode.Uri]> = [
    ['blocks', paths.compressionBlocksRootUri],
    ['sourceLinks', paths.compressionBlockSourceLinksRootUri],
    ['variants', paths.compressionContextVariantsRootUri],
    ['invocationLinks', paths.compressionBlockLlmInvocationLinksRootUri],
    ['invocations', paths.compressionLlmInvocationsRootUri]
  ];
  const traces: string[] = [];
  for (const [key, root] of roots) {
    if (await compressionStoreHasTraces(conversationScopedRoot(root, conversationId))) traces.push(key);
  }
  return traces;
}

async function compressionStoreHasTraces(root: vscode.Uri): Promise<boolean> {
  if (await uriExists(vscode.Uri.joinPath(root, INDEX_FILE))) return true;
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, 'records'));
    return entries.some(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.json'));
  } catch {
    return false;
  }
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  const result = await readJsonStrict<unknown>(uri);
  return result.status === 'ok' || result.status === 'invalid' || result.status === 'ioError';
}

function compressionManifestUri(paths: StoragePaths, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(conversationScopedRoot(paths.compressionBlocksRootUri, conversationId), COMPRESSION_MANIFEST_FILE);
}

function normalizeLoadedCompressionBlock(record: CompressionBlockRecord, now: number): CompressionBlockRecord {
  if (record.status !== 'pending' && record.status !== 'running') return record;
  return {
    ...record,
    status: 'error',
    error: record.error ?? '压缩请求已中断，未收到完成事件；请重新生成。',
    updatedAt: Math.max(record.updatedAt, now),
    completedAt: record.completedAt ?? now
  };
}

function normalizeLoadedLlmInvocation(record: LlmInvocationRecord, now: number): LlmInvocationRecord {
  if (record.status !== 'resolving' && record.status !== 'ready' && record.status !== 'streaming') return record;
  return {
    ...record,
    status: 'error',
    error: record.error ?? 'LLM 调用已中断，未收到完成事件。',
    completedAt: record.completedAt ?? now
  };
}

function compressionTransactionUri(paths: StoragePaths, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(conversationScopedRoot(paths.compressionBlocksRootUri, conversationId), '.compression-store-transaction');
}

function conversationScopedRoot(root: vscode.Uri, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(root, CONVERSATIONS_DIR, safeShardName(conversationId));
}

function conversationScopedIndex(root: vscode.Uri, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(conversationScopedRoot(root, conversationId), INDEX_FILE);
}

function conversationScopedStore(root: vscode.Uri, conversationId: string): { root: vscode.Uri; index: vscode.Uri } {
  const scopedRoot = conversationScopedRoot(root, conversationId);
  return { root: scopedRoot, index: vscode.Uri.joinPath(scopedRoot, INDEX_FILE) };
}

function emptyDiagnostics<TRecord extends { id: string }>(): RecordStoreDiagnosticsResult<TRecord> {
  return { records: [], indexCount: 0, recordFileCount: 0, indexedIds: [], orphanIds: [] };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

function mergeRecordsById<TRecord extends { id: string }>(existing: readonly TRecord[], next: readonly TRecord[]): TRecord[] {
  assertUniqueRecords(existing, 'compression.merge.existing');
  assertUniqueRecords(next, 'compression.merge.next');
  const merged = new Map<string, TRecord>();
  for (const record of existing) merged.set(record.id, record);
  for (const record of next) merged.set(record.id, record);
  return [...merged.values()];
}

function shouldRecoverOrphanCompressionBlock(
  block: CompressionBlockRecord,
  input: {
    latestIndexedCompleteSeq: number;
    sourceLinks: readonly CompressionBlockSourceLinkRecord[];
    variants: readonly CompressionContextVariantRecord[];
    knownMessageIds?: ReadonlySet<string>;
  }
): { recover: boolean; reason: string } {
  if (block.status !== 'complete') return { recover: false, reason: `status:${block.status}` };
  const seq = block.anchorSeq ?? block.endSeq ?? -1;
  if (seq <= input.latestIndexedCompleteSeq) return { recover: false, reason: 'not_newer_than_indexed_complete' };
  if (input.variants.length === 0) return { recover: false, reason: 'missing_variant' };
  const messageSources = input.sourceLinks.filter((link) => link.sourceKind === 'message');
  if (input.knownMessageIds !== undefined) {
    if (messageSources.length === 0) return { recover: false, reason: 'missing_message_sources' };
    const missing = messageSources.find((link) => !input.knownMessageIds?.has(link.sourceId));
    if (missing) return { recover: false, reason: `missing_source_message:${missing.sourceId}` };
  }
  return { recover: true, reason: 'valid_orphan_complete_block' };
}

function safeShardName(id: string): string {
  const slug = id.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'conversation';
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
