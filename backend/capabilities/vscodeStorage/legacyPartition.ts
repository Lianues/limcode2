import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  ClientState,
  ContentPart,
  ConversationOriginLinkRecord,
  InlineDataPart,
  SidebarConversationHistoryEntry
} from '../../../shared/protocol';
import { createEmptyClientState, CLIENT_STATE_TABLE_KEYS } from '../../../shared/clientStateSchema';
import { stripConversationFromClientState } from '../../utils/clientStateConversationCascade';
import { createClientStateSkeletonPatch } from './clientStateSkeletonPatch';
import {
  loadClientStateSkeletonSnapshotFromStores,
  loadConversationDetailFromStores,
  loadConversationTimelineMetaFromStores,
  saveClientStateSkeletonToStores,
  saveConversationRenderDetailToStores,
  saveConversationRunHistoryToStores
} from './clientStateStore';
import {
  openClientStateSkeletonSnapshot,
  releaseClientStateSkeletonSnapshot
} from './clientStateSkeletonTransaction';
import {
  loadConversationHistoryPageFromStore,
  upsertConversationHistoryEntryInStore
} from './conversationHistoryStore';
import { loadManagedAttachmentData } from './attachmentStore';
import { createVscodeStoragePaths } from './paths';
import { isFileNotFoundError, readJsonStrict, writeJsonAtomic } from './json';
import { deleteStorageUri, ensureStorageDirectory } from './storageFs';
import { sanitizeShadowStorageKey } from './shadowWorktreeLock';

export const LEGACY_PARTITION_ID = 'legacy-partition-v1';
const MANIFEST_KIND = 'limcode.workspaceRuntimeLegacyPartition';
const MANIFEST_SCHEMA_VERSION = 2;
const STAGING_DIR = 'legacy-partition-v1-staging';
const SCOPES_DIR = 'scopes';

type ConversationClassification = 'pendingOwner' | 'unboundAssignedToFirst' | 'discardedEmpty' | 'failed';
type ConversationPhase = 'classified' | 'copied' | 'verified' | 'discardedEmpty' | 'failed';

export interface LegacyPartitionConversationRecord {
  conversationId: string;
  messageCount: number;
  classification: ConversationClassification;
  phase: ConversationPhase;
  targetScopeKey?: string;
  ownershipSource?: 'conversationProjectLinks' | 'conversationWorkEnvironmentLinks' | 'historyProjectFolderUri' | 'firstWorkspace';
  ownershipUri?: string;
  error?: string;
}

export interface LegacyPartitionAudit {
  matched: number;
  unboundAssignedToFirst: number;
  discardedEmpty: number;
  failed: number;
}

export interface LegacyPartitionCrossScopeOrigin {
  kind: 'conversationBranchLink' | 'conversationOriginLink';
  linkId: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceScopeKey: string;
  targetScopeKey: string;
}

export interface LegacyPartitionManifest {
  kind: typeof MANIFEST_KIND;
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  migrationId: typeof LEGACY_PARTITION_ID;
  sourceRevision: string;
  status: 'preparing' | 'committed';
  firstWorkspaceScopeKey: string;
  startedAt: string;
  updatedAt: string;
  committedAt?: string;
  audit: LegacyPartitionAudit;
  conversations: LegacyPartitionConversationRecord[];
  crossScopeOrigins: LegacyPartitionCrossScopeOrigin[];
}

export interface LegacyPartitionScopeIdentity {
  scopeKey: string;
  canClaimLegacy: boolean;
  workspaceFolderUris: readonly string[];
}

export interface LegacyPartitionLocations {
  configurationRootUri: vscode.Uri;
  managementRootUri: vscode.Uri;
  manifestUri: vscode.Uri;
  scopedRootUri: vscode.Uri;
}

export interface LegacyPartitionTestHooks {
  afterManifestPrepared?: (manifest: LegacyPartitionManifest) => void | Promise<void>;
  afterScopePublished?: (scopeKey: string, manifest: LegacyPartitionManifest) => void | Promise<void>;
  beforeManifestCommitted?: (manifest: LegacyPartitionManifest) => void | Promise<void>;
}

export const __legacyPartitionTestHooks: LegacyPartitionTestHooks = {};

/** Must be called while holding the manifest's cross-process resource lock. */
export async function resolveLegacyPartition(
  locations: LegacyPartitionLocations,
  scope: LegacyPartitionScopeIdentity,
  hasLegacyRuntimeData: () => Promise<boolean>
): Promise<vscode.Uri> {
  const existing = await readManifest(locations.manifestUri);
  if (existing?.status === 'committed') return locations.scopedRootUri;
  if (!existing && (!scope.canClaimLegacy || !await hasLegacyRuntimeData())) return locations.scopedRootUri;
  if (!scope.canClaimLegacy) return locations.scopedRootUri;

  const manifest = existing ?? await prepareManifest(locations, scope.scopeKey);
  bindCurrentWorkspace(manifest, scope);
  await executeManifest(locations, manifest, scope.scopeKey);
  return locations.scopedRootUri;
}

export async function readLegacyPartitionManifest(uri: vscode.Uri): Promise<LegacyPartitionManifest | undefined> {
  return readManifest(uri);
}

async function prepareManifest(locations: LegacyPartitionLocations, firstWorkspaceScopeKey: string): Promise<LegacyPartitionManifest> {
  const sourcePaths = createVscodeStoragePaths(locations.configurationRootUri, locations.configurationRootUri);
  const pin = await openClientStateSkeletonSnapshot(sourcePaths, `${LEGACY_PARTITION_ID}:classify`);
  const skeleton = pin ? await loadClientStateSkeletonSnapshotFromStores(sourcePaths, pin) : undefined;
  try {
    const state = skeleton ?? createEmptyClientState();
    const history = await loadAllHistory(sourcePaths);
    const historyById = new Map(history.entries.map((entry) => [entry.id, entry]));
    const conversations: LegacyPartitionConversationRecord[] = [];

    for (const conversation of state.conversations) {
      try {
        const meta = await loadConversationTimelineMetaFromStores(sourcePaths, conversation.id);
        if (meta.totalMessages === 0) {
          conversations.push({
            conversationId: conversation.id,
            messageCount: 0,
            classification: 'discardedEmpty',
            phase: 'discardedEmpty'
          });
          continue;
        }
        const owner = await inferConversationOwner(state, conversation.id, historyById.get(conversation.id));
        conversations.push(owner ? {
          conversationId: conversation.id,
          messageCount: meta.totalMessages,
          classification: 'pendingOwner',
          phase: 'classified',
          ownershipSource: owner.source,
          ownershipUri: owner.uri
        } : {
          conversationId: conversation.id,
          messageCount: meta.totalMessages,
          classification: 'unboundAssignedToFirst',
          phase: 'classified',
          targetScopeKey: firstWorkspaceScopeKey,
          ownershipSource: 'firstWorkspace'
        });
      } catch (error) {
        conversations.push({
          conversationId: conversation.id,
          messageCount: 0,
          classification: 'failed',
          phase: 'failed',
          error: errorMessage(error)
        });
      }
    }

    const now = new Date().toISOString();
    const manifest: LegacyPartitionManifest = {
      kind: MANIFEST_KIND,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      migrationId: LEGACY_PARTITION_ID,
      sourceRevision: sourceRevision(pin?.manifestRevision, conversations),
      status: 'preparing',
      firstWorkspaceScopeKey,
      startedAt: now,
      updatedAt: now,
      audit: auditFor(conversations),
      conversations,
      crossScopeOrigins: collectCrossScopeOrigins(state, conversations)
    };
    await writeJsonAtomic(locations.manifestUri, manifest);
    await __legacyPartitionTestHooks.afterManifestPrepared?.(clone(manifest));
    return manifest;
  } finally {
    if (pin) await releaseClientStateSkeletonSnapshot(sourcePaths, pin);
  }
}

function bindCurrentWorkspace(manifest: LegacyPartitionManifest, scope: LegacyPartitionScopeIdentity): void {
  const folders = scope.workspaceFolderUris.map(canonicalUri);
  for (const record of manifest.conversations) {
    if (record.classification !== 'pendingOwner' || record.targetScopeKey || !record.ownershipUri) continue;
    if (folders.some((folder) => uriContains(folder, record.ownershipUri!))) record.targetScopeKey = scope.scopeKey;
  }
}

async function executeManifest(locations: LegacyPartitionLocations, manifest: LegacyPartitionManifest, scopeKey: string): Promise<void> {
  const scopeRecords = manifest.conversations.filter((record) =>
    record.targetScopeKey === scopeKey
    && record.classification !== 'discardedEmpty'
    && record.classification !== 'failed'
  );
  const pendingRecords = scopeRecords.filter((record) => record.phase !== 'verified');
  if (pendingRecords.length > 0) {
    const sourcePaths = createVscodeStoragePaths(locations.configurationRootUri, locations.configurationRootUri);
    const pin = await openClientStateSkeletonSnapshot(sourcePaths, `${LEGACY_PARTITION_ID}:copy`);
    const skeleton = pin ? await loadClientStateSkeletonSnapshotFromStores(sourcePaths, pin) : undefined;
    try {
      const fullState = skeleton ?? createEmptyClientState();
      const history = await loadAllHistory(sourcePaths);
      const validIds = new Set(manifest.conversations
        .filter((record) => record.classification !== 'discardedEmpty' && record.classification !== 'failed')
        .map((record) => record.conversationId));
      const detailByConversation = new Map<string, ClientState>();
      for (const record of pendingRecords) {
        const detail = await loadConversationDetailFromStores(sourcePaths, record.conversationId, { includeRunHistory: true });
        if (!detail) throw new Error(`Legacy conversation detail is missing: ${record.conversationId}`);
        await hydrateManagedAttachments(sourcePaths, detail);
        detailByConversation.set(record.conversationId, detail);
        mergeClientState(fullState, detail);
      }

      const expectedCounts = new Map(scopeRecords.map((record) => [record.conversationId, record.messageCount]));
      const targetRoot = vscode.Uri.joinPath(locations.managementRootUri, SCOPES_DIR, scopeKey);
      if (!await verifyPublishedScope(targetRoot, locations.configurationRootUri, expectedCounts)) {
        if (await exists(targetRoot)) throw new Error(`Legacy target scope already exists and does not match: ${scopeKey}`);
        await rebuildScope(locations, manifest, scopeKey, fullState, history, validIds, detailByConversation);
      }
      for (const record of scopeRecords) record.phase = 'verified';
      manifest.crossScopeOrigins = collectCrossScopeOrigins(fullState, manifest.conversations);
      manifest.updatedAt = new Date().toISOString();
      await writeJsonAtomic(locations.manifestUri, manifest);
      await __legacyPartitionTestHooks.afterScopePublished?.(scopeKey, clone(manifest));
    } finally {
      if (pin) await releaseClientStateSkeletonSnapshot(sourcePaths, pin);
    }
  }

  const unfinished = manifest.conversations.some((record) =>
    record.classification !== 'discardedEmpty'
    && record.classification !== 'failed'
    && record.phase !== 'verified'
  );
  if (unfinished) return;
  await __legacyPartitionTestHooks.beforeManifestCommitted?.(clone(manifest));
  manifest.status = 'committed';
  manifest.committedAt = new Date().toISOString();
  manifest.updatedAt = manifest.committedAt;
  manifest.audit = auditFor(manifest.conversations);
  await writeJsonAtomic(locations.manifestUri, manifest);
  console.info(`[LimCode] Legacy workspace partition committed: ${JSON.stringify(manifest.audit)}`);
}

async function rebuildScope(
  locations: LegacyPartitionLocations,
  manifest: LegacyPartitionManifest,
  scopeKey: string,
  fullState: ClientState,
  history: Awaited<ReturnType<typeof loadAllHistory>>,
  validIds: ReadonlySet<string>,
  detailByConversation: ReadonlyMap<string, ClientState>
): Promise<void> {
  const stagingRoot = vscode.Uri.joinPath(locations.managementRootUri, STAGING_DIR, scopeKey);
  const targetRoot = vscode.Uri.joinPath(locations.managementRootUri, SCOPES_DIR, scopeKey);
  await deleteIfExists(stagingRoot);
  await ensureStorageDirectory(stagingRoot);
  const stagingPaths = createVscodeStoragePaths(stagingRoot, locations.configurationRootUri);
  const scopeConversationIds = new Set(manifest.conversations
    .filter((record) => record.targetScopeKey === scopeKey && validIds.has(record.conversationId))
    .map((record) => record.conversationId));
  const scopeState = stateForScope(fullState, scopeConversationIds, validIds);

  await saveClientStateSkeletonToStores(
    stagingPaths,
    createClientStateSkeletonPatch(createEmptyClientState(), scopeState)
  );
  for (const conversationId of scopeConversationIds) {
    const detail = detailByConversation.get(conversationId);
    if (!detail) throw new Error(`Legacy detail vanished during partition: ${conversationId}`);
    await saveConversationRenderDetailToStores(stagingPaths, conversationId, createEmptyClientState(), detail);
    await saveConversationRunHistoryToStores(stagingPaths, conversationId, detail, { mode: 'replace', force: true });
    await copyConversationSettings(locations.configurationRootUri, stagingRoot, conversationId);
  }

  const historyOriginByConversation = new Map(history.originLinks.map((link) => [link.conversationId, link]));
  const historyByConversation = new Map(history.entries.map((entry) => [entry.id, entry]));
  const conversationById = new Map(scopeState.conversations.map((conversation) => [conversation.id, conversation]));
  for (const conversationId of scopeConversationIds) {
    const entry = historyByConversation.get(conversationId) ?? {
      id: conversationId,
      title: conversationById.get(conversationId)?.title ?? conversationId,
      preview: '',
      messageCount: manifest.conversations.find((record) => record.conversationId === conversationId)?.messageCount ?? 0,
      status: 'complete' as const,
      isRunning: false
    };
    const origin = historyOriginByConversation.get(conversationId);
    await upsertConversationHistoryEntryInStore(
      stagingPaths,
      entry,
      origin && originLinkIsLocal(origin, scopeConversationIds) ? origin : undefined
    );
  }
  await copyReachableShadowWorktrees(createVscodeStoragePaths(locations.configurationRootUri, locations.configurationRootUri), stagingPaths, scopeState);

  const expectedCounts = new Map(manifest.conversations
    .filter((record) => record.targetScopeKey === scopeKey && validIds.has(record.conversationId))
    .map((record) => [record.conversationId, record.messageCount]));
  if (!await verifyPublishedScope(stagingRoot, locations.configurationRootUri, expectedCounts)) {
    throw new Error(`Legacy workspace partition verification failed for scope ${scopeKey}.`);
  }
  if (await exists(targetRoot)) throw new Error(`Legacy target scope already exists: ${scopeKey}`);
  await ensureStorageDirectory(vscode.Uri.joinPath(locations.managementRootUri, SCOPES_DIR));
  await vscode.workspace.fs.rename(stagingRoot, targetRoot, { overwrite: false });
  for (const record of manifest.conversations) {
    if (record.targetScopeKey === scopeKey && validIds.has(record.conversationId)) record.phase = 'copied';
  }
}

function stateForScope(fullState: ClientState, wantedIds: ReadonlySet<string>, validIds: ReadonlySet<string>): ClientState {
  let result = clone(fullState);
  for (const conversationId of validIds) {
    if (!wantedIds.has(conversationId)) result = stripConversationFromClientState(result, conversationId);
  }
  for (const conversation of [...result.conversations]) {
    if (!wantedIds.has(conversation.id)) result = stripConversationFromClientState(result, conversation.id);
  }

  const wantedProjectIds = new Set([
    ...result.conversationProjectLinks.map((link) => link.projectContextId),
    ...result.conversationCheckpointRepositoryLinks.map((link) => link.projectContextId),
    ...result.checkpoints.map((checkpoint) => checkpoint.projectContextId)
  ]);
  result.projectContexts = result.projectContexts.filter((context) => wantedProjectIds.has(context.id));
  result.runtimeContextSnapshots = result.runtimeContextSnapshots.filter((snapshot) =>
    !snapshot.conversationId || wantedIds.has(snapshot.conversationId)
  );
  pruneAgentAnswers(result, wantedIds);
  return result;
}

function pruneAgentAnswers(state: ClientState, wantedConversationIds: ReadonlySet<string>): void {
  const runIds = new Set(state.agentRuns.map((run) => run.id));
  state.agentAnswerSubmissionLinks = state.agentAnswerSubmissionLinks.filter((link) =>
    (!link.submitterConversationId || wantedConversationIds.has(link.submitterConversationId))
    && (!link.submitterRunId || runIds.has(link.submitterRunId))
  );
  state.agentAnswerTargetLinks = state.agentAnswerTargetLinks.filter((link) =>
    (!link.targetConversationId || wantedConversationIds.has(link.targetConversationId))
    && (!link.targetRunId || runIds.has(link.targetRunId))
  );
  const referenced = new Set([
    ...state.agentAnswerSubmissionLinks.map((link) => link.answerId),
    ...state.agentAnswerTargetLinks.map((link) => link.answerId)
  ]);
  state.agentAnswers = state.agentAnswers.filter((answer) => referenced.has(answer.id));
}

async function verifyPublishedScope(
  runtimeRoot: vscode.Uri,
  configurationRoot: vscode.Uri,
  expectedCounts: ReadonlyMap<string, number>
): Promise<boolean> {
  if (!await exists(runtimeRoot)) return false;
  const paths = createVscodeStoragePaths(runtimeRoot, configurationRoot);
  let pin;
  try {
    pin = await openClientStateSkeletonSnapshot(paths, `${LEGACY_PARTITION_ID}:verify`);
    if (!pin) return false;
    const state = await loadClientStateSkeletonSnapshotFromStores(paths, pin);
    const actualIds = new Set(state?.conversations.map((conversation) => conversation.id) ?? []);
    if (actualIds.size !== expectedCounts.size || [...expectedCounts.keys()].some((id) => !actualIds.has(id))) return false;
    for (const [conversationId, messageCount] of expectedCounts) {
      const meta = await loadConversationTimelineMetaFromStores(paths, conversationId);
      if (meta.totalMessages !== messageCount || meta.totalMessages === 0) return false;
    }
    const history = await loadAllHistory(paths);
    const historyIds = new Set(history.entries.map((entry) => entry.id));
    if ([...expectedCounts.keys()].some((id) => !historyIds.has(id))) return false;
    return true;
  } catch {
    return false;
  } finally {
    if (pin) await releaseClientStateSkeletonSnapshot(paths, pin);
  }
}

async function inferConversationOwner(
  state: ClientState,
  conversationId: string,
  historyEntry: SidebarConversationHistoryEntry | undefined
): Promise<{ source: 'conversationProjectLinks' | 'conversationWorkEnvironmentLinks' | 'historyProjectFolderUri'; uri: string } | undefined> {
  const projectById = new Map(state.projectContexts.map((context) => [context.id, context]));
  for (const link of state.conversationProjectLinks.filter((candidate) => candidate.conversationId === conversationId)) {
    const uri = projectById.get(link.projectContextId)?.uri;
    if (!uri) throw new Error(`Legacy project ownership is incomplete: ${conversationId}`);
    return { source: 'conversationProjectLinks', uri: canonicalUri(uri) };
  }

  const environmentById = new Map(state.workEnvironments.map((environment) => [environment.id, environment]));
  for (const link of state.conversationWorkEnvironmentLinks.filter((candidate) => candidate.conversationId === conversationId)) {
    const environment = environmentById.get(link.workEnvironmentId);
    if (!environment || environment.kind !== 'localFolder' || !environment.uri) {
      throw new Error(`Legacy work-environment ownership is incomplete: ${conversationId}`);
    }
    return { source: 'conversationWorkEnvironmentLinks', uri: canonicalUri(environment.uri) };
  }

  if (historyEntry?.projectFolderUri) return { source: 'historyProjectFolderUri', uri: canonicalUri(historyEntry.projectFolderUri) };
  return undefined;
}

function canonicalUri(value: string): string {
  const uri = vscode.Uri.parse(value, true);
  if (!uri.scheme || !(uri.path || uri.fsPath)) throw new Error(`Invalid legacy ownership URI: ${value}`);
  return uri.toString(true);
}

function uriContains(folderValue: string, ownerValue: string): boolean {
  const folder = vscode.Uri.parse(folderValue, true);
  const owner = vscode.Uri.parse(ownerValue, true);
  if (folder.scheme.toLowerCase() !== owner.scheme.toLowerCase()
    || (folder.authority ?? '').toLowerCase() !== (owner.authority ?? '').toLowerCase()) return false;
  const insensitive = folder.scheme === 'file' && process.platform === 'win32';
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return insensitive ? normalized.toLowerCase() : normalized;
  };
  const parent = normalize(folder.path || folder.fsPath);
  const child = normalize(owner.path || owner.fsPath);
  return child === parent || child.startsWith(`${parent}/`);
}

async function loadAllHistory(paths: ReturnType<typeof createVscodeStoragePaths>): Promise<{
  entries: SidebarConversationHistoryEntry[];
  originLinks: ConversationOriginLinkRecord[];
}> {
  const page = await loadConversationHistoryPageFromStore(paths, { scope: { kind: 'all' }, limit: Number.MAX_SAFE_INTEGER });
  return { entries: page.entries, originLinks: page.originLinks };
}

async function hydrateManagedAttachments(paths: ReturnType<typeof createVscodeStoragePaths>, state: ClientState): Promise<void> {
  const cache = new Map<string, InlineDataPart | undefined>();
  const hydratePart = async (part: ContentPart): Promise<ContentPart> => {
    if ('inlineData' in part && part.inlineData.attachmentId && !part.inlineData.data) {
      const id = part.inlineData.attachmentId;
      if (!cache.has(id)) cache.set(id, await loadManagedAttachmentData(paths, id));
      return cache.get(id) ?? part;
    }
    if ('functionResponse' in part && part.functionResponse.parts) {
      const parts = await Promise.all(part.functionResponse.parts.map(hydratePart));
      return { ...part, functionResponse: { ...part.functionResponse, parts: parts as InlineDataPart[] } };
    }
    return part;
  };
  for (const message of state.messages) message.content.parts = await Promise.all(message.content.parts.map(hydratePart));
  for (const revision of state.messageRevisions) revision.content.parts = await Promise.all(revision.content.parts.map(hydratePart));
}

async function copyConversationSettings(configurationRoot: vscode.Uri, runtimeRoot: vscode.Uri, conversationId: string): Promise<void> {
  const safeId = conversationId.replace(/[^a-zA-Z0-9_.-]+/g, '_');
  for (const section of ['common', 'llm']) {
    const name = `conversation-${safeId}-${section}.json`;
    const source = vscode.Uri.joinPath(configurationRoot, 'settings', name);
    const target = vscode.Uri.joinPath(runtimeRoot, 'settings', name);
    try {
      const data = await vscode.workspace.fs.readFile(source);
      await ensureStorageDirectory(vscode.Uri.joinPath(runtimeRoot, 'settings'));
      await vscode.workspace.fs.writeFile(target, data);
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
    }
  }
}

async function copyReachableShadowWorktrees(
  source: ReturnType<typeof createVscodeStoragePaths>,
  target: ReturnType<typeof createVscodeStoragePaths>,
  state: ClientState
): Promise<void> {
  for (const repository of state.shadowRepositories) {
    const storageKey = sanitizeShadowStorageKey(repository.storageKey);
    if (!storageKey) throw new Error(`Invalid legacy shadow worktree storageKey: ${repository.storageKey}`);
    const sourceUri = vscode.Uri.joinPath(source.checkpointShadowWorktreesRootUri, storageKey);
    const targetUri = vscode.Uri.joinPath(target.checkpointShadowWorktreesRootUri, storageKey);
    if (!await exists(sourceUri)) continue;
    await ensureStorageDirectory(target.checkpointShadowWorktreesRootUri);
    await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: false });
  }
}

function collectCrossScopeOrigins(
  state: ClientState,
  records: readonly LegacyPartitionConversationRecord[]
): LegacyPartitionCrossScopeOrigin[] {
  const scopeByConversation = new Map(records
    .filter((record): record is LegacyPartitionConversationRecord & { targetScopeKey: string } => !!record.targetScopeKey)
    .map((record) => [record.conversationId, record.targetScopeKey]));
  const result: LegacyPartitionCrossScopeOrigin[] = [];
  const add = (kind: LegacyPartitionCrossScopeOrigin['kind'], linkId: string, sourceConversationId: string, targetConversationId: string) => {
    const sourceScopeKey = scopeByConversation.get(sourceConversationId);
    const targetScopeKey = scopeByConversation.get(targetConversationId);
    if (!sourceScopeKey || !targetScopeKey || sourceScopeKey === targetScopeKey) return;
    result.push({ kind, linkId, sourceConversationId, targetConversationId, sourceScopeKey, targetScopeKey });
  };
  for (const link of state.conversationBranchLinks) add('conversationBranchLink', link.id, link.sourceConversationId, link.targetConversationId);
  for (const link of state.conversationOriginLinks) {
    if (link.sourceConversationId) add('conversationOriginLink', link.id, link.sourceConversationId, link.conversationId);
  }
  return result;
}

function originLinkIsLocal(link: ConversationOriginLinkRecord, scopeConversationIds: ReadonlySet<string>): boolean {
  return !link.sourceConversationId || scopeConversationIds.has(link.sourceConversationId);
}

function mergeClientState(target: ClientState, source: ClientState): void {
  for (const key of CLIENT_STATE_TABLE_KEYS) {
    const current = target[key] as Array<{ id: string }>;
    const incoming = source[key] as Array<{ id: string }>;
    if (incoming.length === 0) continue;
    const byId = new Map(current.map((record) => [record.id, record]));
    for (const record of incoming) byId.set(record.id, clone(record));
    (target as unknown as Record<string, unknown>)[key] = [...byId.values()];
  }
}

function sourceRevision(skeletonRevision: string | undefined, conversations: readonly LegacyPartitionConversationRecord[]): string {
  return createHash('sha256').update(JSON.stringify({ skeletonRevision: skeletonRevision ?? 'missing', conversations })).digest('hex');
}

function auditFor(conversations: readonly LegacyPartitionConversationRecord[]): LegacyPartitionAudit {
  return {
    matched: conversations.filter((record) => record.classification === 'pendingOwner').length,
    unboundAssignedToFirst: conversations.filter((record) => record.classification === 'unboundAssignedToFirst').length,
    discardedEmpty: conversations.filter((record) => record.classification === 'discardedEmpty').length,
    failed: conversations.filter((record) => record.classification === 'failed').length
  };
}

async function readManifest(uri: vscode.Uri): Promise<LegacyPartitionManifest | undefined> {
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') return undefined;
  if (result.status !== 'ok') throw new Error(`Failed to read legacy partition manifest: ${uri.fsPath}`);
  const candidate = result.value as Partial<LegacyPartitionManifest> | undefined;
  if (
    !candidate || candidate.kind !== MANIFEST_KIND || candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION
    || candidate.migrationId !== LEGACY_PARTITION_ID || !/^[a-f0-9]{64}$/.test(candidate.firstWorkspaceScopeKey ?? '')
    || (candidate.status !== 'preparing' && candidate.status !== 'committed') || !Array.isArray(candidate.conversations)
    || !candidate.audit || !Array.isArray(candidate.crossScopeOrigins)
  ) throw new Error(`Invalid legacy partition manifest: ${uri.fsPath}`);
  return candidate as LegacyPartitionManifest;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

async function deleteIfExists(uri: vscode.Uri): Promise<void> {
  try {
    await deleteStorageUri(uri, { recursive: true, useTrash: false });
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
