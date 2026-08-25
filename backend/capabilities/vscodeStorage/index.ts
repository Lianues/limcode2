import { AsyncLocalStorage } from 'node:async_hooks';
import * as vscode from 'vscode';
import type {
  ConversationLlmSettingsRecord,
  ConversationSettingsRecord,
  GlobalSettingsRecord,
  GlobalSettingsSectionValue,
  LlmCompressionConfigsRecord,
  LlmCompressionSettingsRecord,
  LlmProviderConfigRecord,
  LlmProviderConfigsRecord,
  LlmSettingsRecord,
  McpServersSettingsRecord
} from '../../../shared/protocol';
import type { DeleteConversationDataResult, GlobalSettingsStoreResult, StorageCapability } from '../types';
import { SettingsRevisionConflictError } from '../settingsRevisionConflict';
import { loadGlobalSettingsFile, writeGlobalSettingsFile } from './globalSettings';
import { loadLlmProviderConfigsSettings, saveLlmProviderConfigsSettings } from './llmProviderConfigs';
import { loadLlmCompressionConfigsSettings, normalizeLlmCompressionSettings, saveLlmCompressionConfigsSettings } from './llmCompressionConfigs';
import { loadMcpServersSettings, saveMcpServersSettings } from './mcpServers';
import {
  commitGlobalStatus,
  createGlobalSettingsRecord,
  globalStatusFileUri,
  globalStatusRevision,
  loadCommittedGlobalStatus,
  normalizeStatusDataRootPath,
  resolveDataRootUri,
  sameFsPath,
  type LimCodeGlobalStatus
} from './globalStatus';
import { cleanupMigratedStorageRoot, copyStorageRootForMigration } from './migration';
import { createVscodeStoragePaths } from './paths';
import {
  createWorkspaceScopeIdentity,
  isWorkspaceScopeKey,
  listWorkspaceRuntimeScopes,
  resolveWorkspaceRuntimeRoot,
  workspaceScopedRuntimeRoot
} from './workspaceScope';
import { readJsonStrict, writeJson, type StrictJsonReadResult } from './json';
import { withStorageResourceLock } from './storageResourceLock';
import { deleteStorageUri, ensureStorageDirectory } from './storageFs';
import {
  assertNoOtherLiveInstanceUsingDataRoot,
  createDataRootProcessLease,
  DATA_ROOT_MIGRATION_OPERATION,
  withDataRootAdmissionFence
} from './dataRootProcessLease';
import {
  materializeAttachmentFileUri as materializeAttachmentFileUriFromStore,
  resolveAttachmentForClient as resolveAttachmentForClientFromStore
} from './attachmentStore';
import {
  appendToolCallEventRecord,
  collectConversationRunIdsForDeletionFromStores,
  deleteConversationDataFromStores,
  loadClientStateSkeletonSnapshotFromStores,
  loadConversationDetailFromStores,
  loadConversationRunDetailFromStores,
  loadConversationRunHistoryPageFromStores,
  loadConversationTimelineMetaFromStores,
  loadConversationTimelinePageFromStores,
  loadConversationTimelineProjectionContextFromStores,
  loadConversationTimelineRangeFromStores,
  resolveConversationRunIdForMessageFromStores,
  removeMessageRecord,
  saveClientStateSkeletonToStores,
  saveConversationRenderDetailToStores,
  saveConversationTimelineRenderDetailToStores,
  saveConversationRunHistoryToStores,
  saveMessageRecord,
  saveToolCallRecord,
  truncateConversationTimelineFromStores
} from './clientStateStore';
import {
  commitClientStateSkeletonConversationDeletion,
  openClientStateSkeletonSnapshot,
  refreshClientStateSkeletonPin,
  releaseClientStateSkeletonSnapshot,
  type PinnedClientStateSkeletonSnapshot
} from './clientStateSkeletonTransaction';
import {
  loadConversationHistoryPageFromStore,
  loadConversationHistoryPageFromWorkspaceStores,
  removeConversationHistoryEntryFromStore,
  upsertConversationHistoryEntryInStore
} from './conversationHistoryStore';
import { createShadowCheckpoint, detectSystemGit as detectSystemGitCommand, restoreShadowCheckpoint } from './shadowCheckpoint';
import { openShadowCheckpointDiff, registerShadowDiffProvider } from './shadowDiff';
import { cleanupUnusedShadowWorktrees, collectShadowWorktreeStats, deleteShadowWorktrees } from './shadowCheckpointMaintenance';

type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;

type DataRootGateMode = 'shared' | 'exclusive';

interface DataRootGateWaiter {
  mode: DataRootGateMode;
  start: () => void;
}

const DATA_ROOT_GATE_CONTEXT = 'vscode-storage:data-root-gate';

class DataRootMutationGate {
  private activeShared = 0;
  private exclusiveActive = false;
  private readonly queue: DataRootGateWaiter[] = [];
  private readonly context = new AsyncLocalStorage<string>();

  public get isExclusiveActive(): boolean { return this.exclusiveActive; }

  public async runShared<T>(action: () => Promise<T>): Promise<T> {
    if (this.context.getStore() === DATA_ROOT_GATE_CONTEXT) return action();
    await this.acquire('shared');
    try {
      return await this.context.run(DATA_ROOT_GATE_CONTEXT, action);
    } finally {
      this.release('shared');
    }
  }

  public async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.context.getStore() === DATA_ROOT_GATE_CONTEXT) return action();
    await this.acquire('exclusive');
    try {
      return await this.context.run(DATA_ROOT_GATE_CONTEXT, action);
    } finally {
      this.release('exclusive');
    }
  }

  private acquire(mode: DataRootGateMode): Promise<void> {
    if (mode === 'shared' && !this.exclusiveActive && !this.queue.some((waiter) => waiter.mode === 'exclusive')) {
      this.activeShared += 1;
      return Promise.resolve();
    }
    if (mode === 'exclusive' && !this.exclusiveActive && this.activeShared === 0 && this.queue.length === 0) {
      this.exclusiveActive = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ mode, start: resolve });
    });
  }

  private release(mode: DataRootGateMode): void {
    if (mode === 'shared') this.activeShared = Math.max(0, this.activeShared - 1);
    else this.exclusiveActive = false;
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.exclusiveActive || this.activeShared > 0 || this.queue.length === 0) return;
    const first = this.queue[0];
    if (first.mode === 'exclusive') {
      this.queue.shift();
      this.exclusiveActive = true;
      first.start();
      return;
    }
    while (this.queue[0]?.mode === 'shared') {
      const waiter = this.queue.shift()!;
      this.activeShared += 1;
      waiter.start();
    }
  }
}

export function createVsCodeStorageCapability(context: vscode.ExtensionContext): StorageCapability {
  // Workspace identity is intentionally frozen at activation. Folder changes during this
  // Extension Host lifetime must not split one runtime across two roots.
  const workspaceScope = createWorkspaceScopeIdentity({
    workspaceFileUri: vscode.workspace.workspaceFile,
    workspaceFolderUris: vscode.workspace.workspaceFolders?.map((folder) => folder.uri),
    storageUri: context.storageUri
  });
  const conversationWorkspaceScopes = new Map<string, string>();
  let currentConfigurationRootUri = resolveDataRootUri(context);
  let currentPaths = createVscodeStoragePaths(
    workspaceScopedRuntimeRoot(currentConfigurationRootUri, workspaceScope.scopeKey),
    currentConfigurationRootUri
  );
  let currentPathsResolved = false;
  const storageRootChangeListeners = new Set<() => void>();
  const dataRootGate = new DataRootMutationGate();
  const processLease = createDataRootProcessLease(context, () => resolveDataRootUri(context).fsPath);
  let admissionPromise: Promise<void> | undefined;
  let admitted = false;
  let stagedSkeletonPin: PinnedClientStateSkeletonSnapshot | undefined;
  let stagedSkeletonOpened = false;
  let stagedSharedConfigurationPin: PinnedClientStateSkeletonSnapshot | undefined;
  let stagedSharedConfigurationOpened = false;
  context.subscriptions.push({ dispose: () => processLease.dispose() });
  context.subscriptions.push({
    dispose: () => {
      const paths = getPaths();
      const workspacePin = stagedSkeletonPin;
      const sharedConfigurationPin = stagedSharedConfigurationPin;
      stagedSkeletonPin = undefined;
      stagedSkeletonOpened = false;
      stagedSharedConfigurationPin = undefined;
      stagedSharedConfigurationOpened = false;
      if (workspacePin) {
        void releaseClientStateSkeletonSnapshot(paths, workspacePin)
          .catch((error) => console.warn('[LimCode] Failed to release staged workspace skeleton pin during dispose.', error));
      }
      if (sharedConfigurationPin) {
        void releaseClientStateSkeletonSnapshot(sharedConfigurationPaths(paths), sharedConfigurationPin)
          .catch((error) => console.warn('[LimCode] Failed to release staged shared-configuration skeleton pin during dispose.', error));
      }
    }
  });
  registerShadowDiffProvider(context);

  function getPaths(): StoragePaths {
    const configurationRootUri = resolveDataRootUri(context);
    if (!sameFsPath(configurationRootUri.fsPath, currentConfigurationRootUri.fsPath)) {
      updateCurrentPaths(
        configurationRootUri,
        createVscodeStoragePaths(workspaceScopedRuntimeRoot(configurationRootUri, workspaceScope.scopeKey), configurationRootUri),
        false
      );
    }
    return currentPaths;
  }

  function scopedPaths(paths: StoragePaths, scopeKey: string): StoragePaths {
    if (!isWorkspaceScopeKey(scopeKey)) throw new Error(`Invalid workspace runtime scope key: ${scopeKey}`);
    if (scopeKey === workspaceScope.scopeKey) return paths;
    return createVscodeStoragePaths(
      workspaceScopedRuntimeRoot(paths.configurationRootUri, scopeKey),
      paths.configurationRootUri
    );
  }

  function conversationPaths(paths: StoragePaths, conversationId: string): StoragePaths {
    const scopeKey = conversationWorkspaceScopes.get(conversationId.trim());
    return scopeKey ? scopedPaths(paths, scopeKey) : paths;
  }

  function attachmentCandidatePaths(paths: StoragePaths): StoragePaths[] {
    const result = [paths];
    const seen = new Set([workspaceScope.scopeKey]);
    for (const scopeKey of conversationWorkspaceScopes.values()) {
      if (seen.has(scopeKey)) continue;
      seen.add(scopeKey);
      result.push(scopedPaths(paths, scopeKey));
    }
    return result;
  }

  function updateCurrentPaths(configurationRootUri: vscode.Uri, nextPaths: StoragePaths, resolved: boolean): void {
    const previousIdentity = storageRootIdentity(currentPaths);
    currentConfigurationRootUri = configurationRootUri;
    currentPaths = nextPaths;
    currentPathsResolved = resolved;
    if (storageRootIdentity(nextPaths) === previousIdentity) return;
    for (const listener of [...storageRootChangeListeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[LimCode] Storage-root change listener failed.', error);
      }
    }
  }

  async function ensureCurrentPathsResolved(configurationRootUri = resolveDataRootUri(context)): Promise<StoragePaths> {
    if (
      currentPathsResolved
      && sameFsPath(configurationRootUri.fsPath, currentConfigurationRootUri.fsPath)
    ) return currentPaths;
    const runtimeRootUri = await resolveWorkspaceRuntimeRoot(configurationRootUri, workspaceScope);
    updateCurrentPaths(configurationRootUri, createVscodeStoragePaths(runtimeRootUri, configurationRootUri), true);
    return currentPaths;
  }

  function ensureDataRootAdmission(): Promise<void> {
    if (admitted) return Promise.resolve();
    if (!admissionPromise) {
      admissionPromise = withDataRootAdmissionFence(context, async () => {
        // The canonical status and workspace owner are resolved before the first lease is
        // published. A migration holding the same fence therefore cannot miss a newcomer
        // that later enters its source root.
        await loadCommittedGlobalStatus(context);
        await ensureCurrentPathsResolved();
        await processLease.heartbeat();
        processLease.start();
        admitted = true;
      }).catch((error) => {
        admissionPromise = undefined;
        throw error;
      });
    }
    return admissionPromise;
  }

  function withSharedDataRoot<T>(action: (paths: StoragePaths) => Promise<T>): Promise<T> {
    return dataRootGate.runShared(async () => {
      await ensureDataRootAdmission();
      await processLease.heartbeat();
      return action(await ensureCurrentPathsResolved());
    });
  }

  function withExclusiveDataRoot<T>(action: (paths: StoragePaths) => Promise<T>): Promise<T> {
    return dataRootGate.runExclusive(async () => {
      await ensureDataRootAdmission();
      await processLease.heartbeat();
      return action(await ensureCurrentPathsResolved());
    });
  }


  async function loadCommonGlobalSettings(): Promise<GlobalSettingsStoreResult> {
    const status = await loadCommittedGlobalStatus(context);
    return {
      section: 'common',
      settings: createGlobalSettingsRecord(context, status),
      filePath: globalStatusFileUri(context).fsPath,
      revision: globalStatusRevision(status)
    };
  }

  async function saveCommonGlobalSettings(
    settings: GlobalSettingsSectionValue,
    expectedRevision: string
  ): Promise<GlobalSettingsStoreResult> {
    return withExclusiveDataRoot(async () => {
      const input = settings as Partial<GlobalSettingsRecord> | undefined;
      const targetDataRootPath = normalizeStatusDataRootPath(context, input?.dataFilePath ?? '');
      const targetRootUri = resolveDataRootUri(context, targetDataRootPath);
      await processLease.setActiveOperation({ kind: DATA_ROOT_MIGRATION_OPERATION, targetRootPath: targetRootUri.fsPath });
      try {
        return await withDataRootAdmissionFence(context, async () => {
          const currentStatus = await loadCommittedGlobalStatus(context);
          const actualRevision = globalStatusRevision(currentStatus);
          if (actualRevision !== expectedRevision) {
            throw new SettingsRevisionConflictError('common', expectedRevision, actualRevision);
          }
          const sourceRootUri = resolveDataRootUri(context, currentStatus.dataRootPath);
          const committed = await prepareAndRunStorageRootMigration(
            currentStatus,
            sourceRootUri,
            targetRootUri,
            targetDataRootPath,
            input?.proxy ?? ''
          );
          await processLease.heartbeat();
          return committed;
        });
      } finally {
        await processLease.clearActiveOperation(DATA_ROOT_MIGRATION_OPERATION);
      }
    });
  }

  async function prepareAndRunStorageRootMigration(
    currentStatus: LimCodeGlobalStatus,
    sourceRootUri: vscode.Uri,
    targetRootUri: vscode.Uri,
    targetDataRootPath: string,
    proxy: string
  ): Promise<GlobalSettingsStoreResult> {
    const previousSettings = createGlobalSettingsRecord(context, currentStatus);
    const migration = await copyStorageRootAfterLeaseCheck(sourceRootUri, targetRootUri);
    const nextStatus = await commitGlobalStatus(
      context,
      currentStatus,
      targetDataRootPath,
      proxy,
      migration.skipped ? undefined : {
        fromPath: migration.fromPath,
        toPath: migration.toPath,
        migratedAt: migration.migratedAt
      }
    );
    await ensureCurrentPathsResolved(resolveDataRootUri(context, nextStatus.dataRootPath));
    await processLease.heartbeat();
    if (!migration.skipped) {
      const activeRootAfterSave = resolveDataRootUri(context, nextStatus.dataRootPath);
      if (sameFsPath(activeRootAfterSave.fsPath, targetRootUri.fsPath)) {
        try {
          const cleanup = await cleanupMigratedStorageRoot(sourceRootUri, migration.copiedEntries);
          for (const failure of cleanup.failedEntries) {
            console.warn(`[LimCode] Failed to cleanup migrated storage root entry ${failure.name}:`, failure.error);
          }
        } catch (error) {
          console.warn('[LimCode] Failed to cleanup migrated storage root:', error);
        }
      } else {
        console.warn('[LimCode] Skip migrated storage root cleanup because active root changed before cleanup.', {
          expected: targetRootUri.fsPath,
          actual: activeRootAfterSave.fsPath
        });
      }
    }
    return {
      section: 'common',
      settings: createGlobalSettingsRecord(context, nextStatus),
      filePath: globalStatusFileUri(context).fsPath,
      revision: globalStatusRevision(nextStatus),
      previousSettings,
      dataRootChanged: !migration.skipped
    };
  }

  async function copyStorageRootAfterLeaseCheck(sourceRootUri: vscode.Uri, targetRootUri: vscode.Uri) {
    if (!sameFsPath(sourceRootUri.fsPath, targetRootUri.fsPath)) {
      // Both checks run after the cross-process admission fence is held. New instances cannot
      // publish a source/target lease until copy, commit, and cleanup have all completed.
      await assertNoOtherLiveInstanceUsingDataRoot(context, processLease.instanceId, sourceRootUri.fsPath, 'source');
      await assertNoOtherLiveInstanceUsingDataRoot(context, processLease.instanceId, targetRootUri.fsPath, 'target');
    }
    return copyStorageRootForMigration(sourceRootUri, targetRootUri);
  }

  async function saveNormalizedLlmGlobalSettings(
    paths: StoragePaths,
    settings: GlobalSettingsSectionValue,
    expectedRevision: string
  ): Promise<GlobalSettingsStoreResult> {
    await ensureLlmSettingsRoots(paths);
    const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
    const input = settings as Partial<LlmSettingsRecord> | undefined;
    const activeConfig = configs.find((config) => config.id === input?.activeProviderConfigId) ?? configs[0];
    const stored = await writeGlobalSettingsFile(
      paths.settingsRootUri,
      'llm',
      { activeProviderConfigId: activeConfig?.id ?? '' },
      expectedRevision
    );
    return stored;
  }

  return {
    get paths() { return getPaths(); },
    get workspaceScopeKey() { return workspaceScope.scopeKey; },
    bindConversationWorkspaceScope(conversationId, scopeKey) {
      const id = conversationId.trim();
      if (!id) throw new Error('conversationId is required for workspace scope binding.');
      if (!isWorkspaceScopeKey(scopeKey)) throw new Error(`Invalid workspace runtime scope key: ${scopeKey}`);
      if (scopeKey === workspaceScope.scopeKey) conversationWorkspaceScopes.delete(id);
      else conversationWorkspaceScopes.set(id, scopeKey);
    },
    unbindConversationWorkspaceScope(conversationId) {
      conversationWorkspaceScopes.delete(conversationId.trim());
    },
    onDidChangeStorageRoot(listener) {
      storageRootChangeListeners.add(listener);
      return { dispose: () => storageRootChangeListeners.delete(listener) };
    },
    isDataRootReady() { return admitted; },
    isDataRootMutationActive() { return dataRootGate.isExclusiveActive; },
    async ensureReady() {
      return withSharedDataRoot(async () => {
        // 业务 settings 仍按需懒加载，避免阻塞侧边栏首屏。
      });
    },
    async loadClientStateSkeleton(options) {
      return withSharedDataRoot(async (paths) => {
        const profile = options?.profile ?? 'full';
        if (profile === 'startup') {
          if (stagedSkeletonPin) await releaseClientStateSkeletonSnapshot(paths, stagedSkeletonPin);
          stagedSkeletonPin = undefined;
          stagedSkeletonOpened = false;
          const pin = await openClientStateSkeletonSnapshot(paths, processLease.instanceId);
          try {
            const state = pin
              ? await loadClientStateSkeletonSnapshotFromStores(paths, pin, { profile: 'startup' })
              : undefined;
            stagedSkeletonPin = pin;
            stagedSkeletonOpened = true;
            return state;
          } catch (error) {
            if (pin) await releaseClientStateSkeletonSnapshot(paths, pin);
            throw error;
          }
        }
        if (profile === 'deferred') {
          if (!stagedSkeletonOpened) throw new Error('Deferred client-state skeleton load requires a startup snapshot pin.');
          const pin = stagedSkeletonPin;
          try {
            if (!pin) return undefined;
            await refreshClientStateSkeletonPin(paths, pin);
            return loadClientStateSkeletonSnapshotFromStores(paths, pin, { profile: 'deferred' });
          } finally {
            if (pin) await releaseClientStateSkeletonSnapshot(paths, pin);
            stagedSkeletonPin = undefined;
            stagedSkeletonOpened = false;
          }
        }

        const pin = await openClientStateSkeletonSnapshot(paths, processLease.instanceId);
        if (!pin) return undefined;
        try {
          return await loadClientStateSkeletonSnapshotFromStores(paths, pin, { profile: 'full' });
        } finally {
          await releaseClientStateSkeletonSnapshot(paths, pin);
        }
      });
    },
    async loadWorkspaceClientStateSkeleton(scopeKey, options) {
      return withSharedDataRoot(async (paths) => {
        const targetPaths = scopedPaths(paths, scopeKey);
        const pin = await openClientStateSkeletonSnapshot(
          targetPaths,
          `${processLease.instanceId}:workspace-scope:${scopeKey}`
        );
        if (!pin) return undefined;
        try {
          return await loadClientStateSkeletonSnapshotFromStores(
            targetPaths,
            pin,
            { profile: options?.profile ?? 'full' }
          );
        } finally {
          await releaseClientStateSkeletonSnapshot(targetPaths, pin);
        }
      });
    },
    async loadSharedConfigurationSkeleton(options) {
      return withSharedDataRoot(async (paths) => {
        const sharedPaths = sharedConfigurationPaths(paths);
        const profile = options?.profile ?? 'full';
        if (profile === 'startup') {
          if (stagedSharedConfigurationPin) {
            await releaseClientStateSkeletonSnapshot(sharedPaths, stagedSharedConfigurationPin);
          }
          stagedSharedConfigurationPin = undefined;
          stagedSharedConfigurationOpened = false;
          const pin = await openClientStateSkeletonSnapshot(sharedPaths, `${processLease.instanceId}:shared-configuration`);
          try {
            const state = pin
              ? await loadClientStateSkeletonSnapshotFromStores(sharedPaths, pin, { profile: 'startup' })
              : undefined;
            stagedSharedConfigurationPin = pin;
            stagedSharedConfigurationOpened = true;
            return state;
          } catch (error) {
            if (pin) await releaseClientStateSkeletonSnapshot(sharedPaths, pin);
            throw error;
          }
        }
        if (profile === 'deferred') {
          if (!stagedSharedConfigurationOpened) {
            throw new Error('Deferred shared-configuration skeleton load requires a startup snapshot pin.');
          }
          const pin = stagedSharedConfigurationPin;
          try {
            if (!pin) return undefined;
            await refreshClientStateSkeletonPin(sharedPaths, pin);
            return loadClientStateSkeletonSnapshotFromStores(sharedPaths, pin, { profile: 'deferred' });
          } finally {
            if (pin) await releaseClientStateSkeletonSnapshot(sharedPaths, pin);
            stagedSharedConfigurationPin = undefined;
            stagedSharedConfigurationOpened = false;
          }
        }

        const pin = await openClientStateSkeletonSnapshot(sharedPaths, `${processLease.instanceId}:shared-configuration`);
        if (!pin) return undefined;
        try {
          return await loadClientStateSkeletonSnapshotFromStores(sharedPaths, pin, { profile: 'full' });
        } finally {
          await releaseClientStateSkeletonSnapshot(sharedPaths, pin);
        }
      });
    },
    async loadConversationDetail(conversationId, options) {
      return withSharedDataRoot((paths) => {
        const includeRunHistory = options?.includeRunHistory ?? false;
        return loadConversationDetailFromStores(conversationPaths(paths, conversationId), conversationId, { includeRunHistory });
      });
    },
    async loadConversationTimelineProjectionContext(conversationId, projectionKey, chunkId) {
      return withSharedDataRoot((paths) => loadConversationTimelineProjectionContextFromStores(conversationPaths(paths, conversationId), conversationId, projectionKey, chunkId));
    },
    async loadConversationTimelineMeta(conversationId) {
      return withSharedDataRoot((paths) => loadConversationTimelineMetaFromStores(conversationPaths(paths, conversationId), conversationId));
    },
    async loadConversationTimelinePage(request) {
      return withSharedDataRoot((paths) => loadConversationTimelinePageFromStores(conversationPaths(paths, request.conversationId), request));
    },
    async loadConversationTimelineRange(request) {
      return withSharedDataRoot((paths) => loadConversationTimelineRangeFromStores(conversationPaths(paths, request.conversationId), request));
    },
    async truncateConversationTimeline(request) {
      return withSharedDataRoot((paths) => truncateConversationTimelineFromStores(conversationPaths(paths, request.conversationId), request));
    },
    async saveClientStateSkeleton(patch) {
      return withSharedDataRoot((paths) => saveClientStateSkeletonToStores(paths, patch));
    },
    async saveWorkspaceClientStateSkeleton(scopeKey, patch) {
      return withSharedDataRoot((paths) => saveClientStateSkeletonToStores(scopedPaths(paths, scopeKey), patch));
    },
    async saveSharedConfigurationSkeleton(patch) {
      return withSharedDataRoot((paths) => saveClientStateSkeletonToStores(sharedConfigurationPaths(paths), patch));
    },
    async saveConversationRenderDetail(conversationId, localBase, localNext) {
      return withSharedDataRoot(async (paths) => {
        return saveConversationRenderDetailToStores(conversationPaths(paths, conversationId), conversationId, localBase, localNext);
      });
    },
    async saveConversationTimelineRenderDetail(conversationId, localBase, localNext) {
      return withSharedDataRoot(async (paths) => {
        return saveConversationTimelineRenderDetailToStores(conversationPaths(paths, conversationId), conversationId, localBase, localNext);
      });
    },
    async saveConversationRunHistory(conversationId, state, options) {
      return withSharedDataRoot(async (paths) => {
        await saveConversationRunHistoryToStores(conversationPaths(paths, conversationId), conversationId, state, options);
      });
    },
    async loadConversationRunHistoryPage(request) {
      return withSharedDataRoot((paths) => loadConversationRunHistoryPageFromStores(conversationPaths(paths, request.conversationId), request));
    },
    async loadConversationRunDetail(request) {
      return withSharedDataRoot((paths) => loadConversationRunDetailFromStores(conversationPaths(paths, request.conversationId), request));
    },
    async resolveConversationRunIdForMessage(conversationId, messageId) {
      return withSharedDataRoot((paths) => resolveConversationRunIdForMessageFromStores(conversationPaths(paths, conversationId), conversationId, messageId));
    },
    async loadConversationHistoryPage(request) {
      return withSharedDataRoot(async (paths) => {
        if (request.scope.kind !== 'all') {
          return loadConversationHistoryPageFromStore(paths, request, { workspaceScopeKey: workspaceScope.scopeKey });
        }
        const scopes = await listWorkspaceRuntimeScopes(paths.configurationRootUri);
        const sources = new Map(scopes.map((scope) => [scope.scopeKey, scope.rootUri]));
        sources.set(workspaceScope.scopeKey, paths.workspaceRuntimeRootUri);
        return loadConversationHistoryPageFromWorkspaceStores(
          [...sources.entries()].map(([scopeKey, rootUri]) => ({
            paths: createVscodeStoragePaths(rootUri, paths.configurationRootUri),
            workspaceScopeKey: scopeKey,
            preferred: scopeKey === workspaceScope.scopeKey
          })),
          request
        );
      });
    },
    async upsertConversationHistoryEntry(entry, originLink) {
      return withSharedDataRoot(async (paths) => {
        await upsertConversationHistoryEntryInStore(conversationPaths(paths, entry.id), entry, originLink);
      });
    },
    async removeConversationHistoryEntry(conversationId) {
      return withSharedDataRoot(async (paths) => {
        await removeConversationHistoryEntryFromStore(conversationPaths(paths, conversationId), conversationId);
      });
    },
    async deleteConversationSkeleton(conversationId, runIds) {
      return withSharedDataRoot(async (paths) => {
        const targetPaths = conversationPaths(paths, conversationId);
        // 本地 ECS 可能尚未 hydrate 其它窗口持久化的 run；先从 canonical run history
        // 补齐 runId，避免 skeleton 中独立的 run→环境/runtime snapshot Link 成为孤儿。
        const persistedRunIds = await collectConversationRunIdsForDeletionFromStores(targetPaths, conversationId);
        const allRunIds = new Set([...(runIds ?? []), ...persistedRunIds]);
        await commitClientStateSkeletonConversationDeletion(targetPaths, conversationId, allRunIds);
        return { runIds: [...allRunIds] };
      });
    },
    async deleteConversationData(conversationId) {
      return withSharedDataRoot(async (paths) => {
        const targetPaths = conversationPaths(paths, conversationId);
        const result: DeleteConversationDataResult = await deleteConversationDataFromStores(targetPaths, conversationId);
        await collectDeleteStep(result, () => removeConversationHistoryEntryFromStore(targetPaths, conversationId), `history:${conversationId}`);
        await collectDeleteStep(result, () => deleteStorageUri(conversationSettingsUri(targetPaths, conversationId, 'common'), { useTrash: false }), conversationSettingsUri(targetPaths, conversationId, 'common').fsPath, true);
        await collectDeleteStep(result, () => deleteStorageUri(conversationSettingsUri(targetPaths, conversationId, 'llm'), { useTrash: false }), conversationSettingsUri(targetPaths, conversationId, 'llm').fsPath, true);
        return { ...result, ok: result.errors.length === 0 };
      });
    },
    async saveMessageSnapshot(conversationId, message) {
      return withSharedDataRoot(async (paths) => {
        await saveMessageRecord(conversationPaths(paths, conversationId), conversationId, message);
      });
    },
    async removeMessage(conversationId, messageId) {
      return withSharedDataRoot(async (paths) => {
        await removeMessageRecord(conversationPaths(paths, conversationId), conversationId, messageId);
      });
    },
    async saveToolCallSnapshot(conversationId, toolCall) {
      return withSharedDataRoot(async (paths) => {
        await saveToolCallRecord(conversationPaths(paths, conversationId), conversationId, toolCall);
      });
    },
    async appendToolCallEvent(conversationId, event) {
      return withSharedDataRoot(async (paths) => {
        await appendToolCallEventRecord(conversationPaths(paths, conversationId), conversationId, event);
      });
    },
    async resolveAttachmentForClient(input) {
      return withSharedDataRoot(async (paths) => {
        let fallback: Awaited<ReturnType<typeof resolveAttachmentForClientFromStore>> | undefined;
        for (const candidatePaths of attachmentCandidatePaths(paths)) {
          const result = await resolveAttachmentForClientFromStore(candidatePaths, input);
          fallback ??= result;
          if (result.status === 'available') return result;
        }
        return fallback!;
      });
    },
    async materializeAttachmentFileUri(input) {
      return withSharedDataRoot(async (paths) => {
        for (const candidatePaths of attachmentCandidatePaths(paths)) {
          const uri = await materializeAttachmentFileUriFromStore(candidatePaths, input);
          if (uri) return uri;
        }
        return undefined;
      });
    },
    async detectSystemGit() {
      return withSharedDataRoot(async () => detectSystemGitCommand());
    },
    async createShadowCheckpoint(request) {
      return withSharedDataRoot((paths) => createShadowCheckpoint(conversationPaths(paths, request.conversationId), request));
    },
    async restoreShadowCheckpoint(request) {
      return withSharedDataRoot((paths) => restoreShadowCheckpoint(conversationPaths(paths, request.conversationId), request));
    },
    async openShadowCheckpointDiff(request) {
      return withSharedDataRoot((paths) => openShadowCheckpointDiff(conversationPaths(paths, request.conversationId), request));
    },
    async collectShadowWorktreeStats() {
      return withSharedDataRoot((paths) => collectShadowWorktreeStats(paths));
    },
    async deleteShadowWorktrees(storageKeys) {
      return withSharedDataRoot((paths) => deleteShadowWorktrees(paths, storageKeys));
    },
    async cleanupUnusedShadowWorktrees(maxAgeDays) {
      return withSharedDataRoot((paths) => cleanupUnusedShadowWorktrees(paths, maxAgeDays));
    },
    async loadGlobalSettings(section) {
      return withSharedDataRoot(async (paths) => {
        if (section === 'common') return loadCommonGlobalSettings();
        if (section === 'llm') return loadNormalizedLlmGlobalSettings(paths);
        if (section === 'llmProviderConfigs') {
          const stored = await loadLlmProviderConfigsSettings(paths);
          await loadNormalizedLlmGlobalSettings(paths);
          return {
            section,
            settings: stored.settings,
            filePath: stored.filePath,
            revision: stored.revision,
            ...(stored.previousSettings ? { previousSettings: stored.previousSettings } : {})
          };
        }
        if (section === 'llmCompression') {
          const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
          const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llmCompression');
          const settings = normalizeLlmCompressionSettings(stored.settings as Partial<LlmCompressionSettingsRecord> | undefined, configs);
          return { section, settings, filePath: stored.filePath, revision: stored.revision };
        }
        if (section === 'llmCompressionConfigs') {
          const stored = await loadLlmCompressionConfigsSettings(paths);
          return { section, settings: stored.settings, filePath: stored.filePath, revision: stored.revision };
        }
        if (section === 'mcpServers') {
          const stored = await loadMcpServersSettings(paths);
          return { section, settings: stored.settings, filePath: stored.filePath, revision: stored.revision };
        }
        await ensureStorageDirectory(paths.settingsRootUri);
        return loadGlobalSettingsFile(paths.settingsRootUri, section);
      });
    },
    async saveGlobalSettings(section, settings, expectedRevision) {
      if (section === 'common') return saveCommonGlobalSettings(settings, expectedRevision);
      return withSharedDataRoot(async (paths) => {
        if (section === 'llm') return saveNormalizedLlmGlobalSettings(paths, settings, expectedRevision);
        if (section === 'llmProviderConfigs') {
          const stored = await saveLlmProviderConfigsSettings(paths, settings as Partial<LlmProviderConfigsRecord> | undefined, expectedRevision);
          await loadNormalizedLlmGlobalSettings(paths);
          return { section, settings: stored.settings, filePath: stored.filePath, revision: stored.revision };
        }
        if (section === 'llmCompression') {
          const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
          const normalized = normalizeLlmCompressionSettings(settings as Partial<LlmCompressionSettingsRecord> | undefined, configs);
          const stored = await writeGlobalSettingsFile(paths.settingsRootUri, 'llmCompression', normalized, expectedRevision);
          return {
            section,
            settings: stored.settings,
            filePath: stored.filePath,
            revision: stored.revision,
            ...(stored.previousSettings ? { previousSettings: stored.previousSettings } : {})
          };
        }
        if (section === 'llmCompressionConfigs') {
          const stored = await saveLlmCompressionConfigsSettings(paths, settings as Partial<LlmCompressionConfigsRecord> | undefined, expectedRevision);
          return {
            section,
            settings: stored.settings,
            filePath: stored.filePath,
            revision: stored.revision,
            ...(stored.previousSettings ? { previousSettings: stored.previousSettings } : {})
          };
        }
        if (section === 'mcpServers') {
          const stored = await saveMcpServersSettings(paths, settings as Partial<McpServersSettingsRecord> | undefined, expectedRevision);
          return {
            section,
            settings: stored.settings,
            filePath: stored.filePath,
            revision: stored.revision,
            ...(stored.previousSettings ? { previousSettings: stored.previousSettings } : {})
          };
        }
        await ensureStorageDirectory(paths.settingsRootUri);
        return writeGlobalSettingsFile(paths.settingsRootUri, section, settings, expectedRevision);
      });
    },
    async loadActiveLlmProviderConfig(conversationId) {
      return withSharedDataRoot(async (paths) => {
        await ensureLlmSettingsRoots(paths);
        const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
        if (conversationId) {
          const conversationSettings = await this.loadConversationSettings(conversationId, 'llm');
          const llmSettings = conversationSettings?.settings as ConversationLlmSettingsRecord | undefined;
          const activeProviderConfigId = llmSettings?.activeProviderConfigId;
          const conversationConfig = activeProviderConfigId ? configs.find((config) => config.id === activeProviderConfigId) : undefined;
          if (conversationConfig) return applyConversationModelOverride(conversationConfig, llmSettings);
        }
        const stored = await loadNormalizedLlmGlobalSettings(paths);
        const activeConfigId = (stored.settings as LlmSettingsRecord).activeProviderConfigId;
        return configs.find((config) => config.id === activeConfigId) ?? configs[0]!;
      });
    },
    async loadLlmProviderConfigById(configId) {
      return withSharedDataRoot(async (paths) => {
        const id = configId.trim();
        if (!id) return undefined;
        await ensureLlmSettingsRoots(paths);
        return (await loadLlmProviderConfigsSettings(paths)).settings.configs.find((config) => config.id === id);
      });
    },
    async loadActiveLlmCompressionConfig(providerConfigId, modelId) {
      return withSharedDataRoot(async (paths) => {
        await ensureStorageDirectory(paths.settingsRootUri);
        const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
        const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llmCompression');
        const settings = normalizeLlmCompressionSettings(stored.settings as Partial<LlmCompressionSettingsRecord> | undefined, configs);
        const model = modelId?.trim();
        const modelBinding = providerConfigId && model
          ? settings.modelBindings.find((candidate) => candidate.providerConfigId === providerConfigId && candidate.modelId === model)
          : undefined;
        const binding = providerConfigId
          ? settings.providerBindings.find((candidate) => candidate.providerConfigId === providerConfigId)
          : undefined;
        const id = modelBinding?.compressionConfigId ?? binding?.compressionConfigId ?? settings.defaultConfigId ?? configs[0]?.id;
        return configs.find((config) => config.id === id) ?? configs[0];
      });
    },
    async loadLlmCompressionConfigById(configId) {
      return withSharedDataRoot(async (paths) => {
        const id = configId.trim();
        if (!id) return undefined;
        return (await loadLlmCompressionConfigsSettings(paths)).settings.configs.find((config) => config.id === id);
      });
    },
    async loadConversationSettings(conversationId, section, options) {
      return withSharedDataRoot(async (paths) => {
        const targetPaths = conversationPaths(paths, conversationId);
        const uri = conversationSettingsUri(targetPaths, conversationId, section);
        const result = await readJsonStrict<unknown>(uri);
        if (section === 'llm') {
          if (result.status === 'missing') {
            if (options?.initializeMissing === false) return undefined;
            const frozen = await freezeMissingConversationLlmSettingsToCurrentGlobal(targetPaths, conversationId, uri);
            return { conversationId, section, settings: frozen, filePath: uri.fsPath };
          }
          if (result.status !== 'ok') throw strictConversationSettingsReadError(conversationId, section, result);
          const settings = parseConversationLlmSettings(conversationId, uri, result.value);
          const resolved = await repairStaleConversationLlmProviderReference(targetPaths, conversationId, uri, settings);
          return { conversationId, section, settings: resolved, filePath: uri.fsPath };
        }
        if (result.status === 'missing') return undefined;
        if (result.status !== 'ok') throw strictConversationSettingsReadError(conversationId, section, result);
        const settings = parseConversationCommonSettings(conversationId, uri, result.value);
        return { conversationId, section, settings: normalizeConversationCommonSettings(conversationId, settings), filePath: uri.fsPath };
      });
    },
    async saveConversationSettings(section, settings) {
      return withSharedDataRoot(async (paths) => {
        const conversationId = (settings as ConversationSettingsRecord | ConversationLlmSettingsRecord).conversationId;
        const targetPaths = conversationPaths(paths, conversationId);
        await ensureStorageDirectory(targetPaths.conversationSettingsRootUri);
        const normalized = section === 'llm'
          ? normalizeConversationLlmSettings(conversationId, settings as Partial<ConversationLlmSettingsRecord>)
          : normalizeConversationCommonSettings(conversationId, settings as Partial<ConversationSettingsRecord>);
        const uri = conversationSettingsUri(targetPaths, conversationId, section);
        await withStorageResourceLock(uri, async () => {
          await writeJson(uri, toPlainConversationSettings(normalized));
        });
        return { conversationId, section, settings: toPlainConversationSettings(normalized), filePath: uri.fsPath };
      });
    }
  };
}

function sharedConfigurationPaths(paths: StoragePaths): StoragePaths {
  return createVscodeStoragePaths(paths.sharedConfigurationRootUri, paths.configurationRootUri);
}

function storageRootIdentity(paths: StoragePaths): string {
  return `${paths.globalStoragePath}\n${paths.conversationHistoryRootPath}`;
}

async function collectDeleteStep(result: DeleteConversationDataResult, step: () => Thenable<void> | Promise<void>, label: string, ignoreNotFound = false): Promise<void> {
  try {
    await step();
    result.deletedPaths.push(label);
  } catch (error) {
    if (ignoreNotFound && isFileNotFoundError(error)) return;
    result.errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFileNotFoundError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'FileNotFound' || code === 'ENOENT';
}

function conversationSettingsUri(paths: StoragePaths, conversationId: string, section: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.conversationSettingsRootUri, `conversation-${safeFileName(conversationId)}-${section}.json`);
}

function safeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

async function ensureLlmSettingsRoots(paths: StoragePaths): Promise<void> {
  await ensureStorageDirectory(paths.settingsRootUri);
}

async function loadNormalizedLlmGlobalSettings(paths: StoragePaths): Promise<{ section: 'llm'; settings: LlmSettingsRecord; filePath: string; revision: string }> {
  await ensureLlmSettingsRoots(paths);
  const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
  const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llm');
  const settings = stored.settings as LlmSettingsRecord;
  const activeConfig = configs.find((config) => config.id === settings.activeProviderConfigId) ?? configs[0];
  const normalized: LlmSettingsRecord = { activeProviderConfigId: activeConfig?.id ?? '' };
  return { section: 'llm', settings: normalized, filePath: stored.filePath, revision: stored.revision };
}

function normalizeConversationCommonSettings(conversationId: string, settings: Partial<ConversationSettingsRecord> | undefined): ConversationSettingsRecord {
  return { conversationId, name: typeof settings?.name === 'string' ? settings.name : '' };
}

async function freezeMissingConversationLlmSettingsToCurrentGlobal(
  paths: StoragePaths,
  conversationId: string,
  uri: vscode.Uri
): Promise<ConversationLlmSettingsRecord> {
  return withStorageResourceLock(uri, async () => {
    const current = await readJsonStrict<unknown>(uri);
    if (current.status === 'missing') {
      const frozen = await createFrozenConversationLlmSettings(paths, conversationId);
      await writeJson(uri, toPlainConversationSettings(frozen));
      return frozen;
    }
    if (current.status !== 'ok') throw strictConversationSettingsReadError(conversationId, 'llm', current);
    const settings = parseConversationLlmSettings(conversationId, uri, current.value);
    return normalizeConversationLlmSettings(conversationId, settings);
  });
}

async function createFrozenConversationLlmSettings(
  paths: StoragePaths,
  conversationId: string
): Promise<ConversationLlmSettingsRecord> {
  await ensureLlmSettingsRoots(paths);
  const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
  const global = await loadNormalizedLlmGlobalSettings(paths);
  const activeProviderConfigId = (global.settings as LlmSettingsRecord).activeProviderConfigId;
  const activeConfig = configs.find((config) => config.id === activeProviderConfigId) ?? configs[0];
  return normalizeConversationLlmSettings(conversationId, { activeProviderConfigId: activeConfig?.id ?? '' });
}

/**
 * 渠道删除后，旧对话文件可能仍指向已不存在的 provider config。运行时此前会临时回退到
 * 全局渠道，但设置快照仍把失效 id 发给 Webview，导致每次重载都显示成未选择。
 * 只在确认引用失效时进入资源锁重读，并把实际采用的全局 fallback 原子写回。
 */
async function repairStaleConversationLlmProviderReference(
  paths: StoragePaths,
  conversationId: string,
  uri: vscode.Uri,
  input: ConversationLlmSettingsRecord
): Promise<ConversationLlmSettingsRecord> {
  const normalized = normalizeConversationLlmSettings(conversationId, input);
  const initialConfigs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
  if (initialConfigs.some((config) => config.id === normalized.activeProviderConfigId)) return normalized;

  return withStorageResourceLock(uri, async () => {
    const current = await readJsonStrict<unknown>(uri);
    if (current.status === 'missing') {
      const frozen = await createFrozenConversationLlmSettings(paths, conversationId);
      await writeJson(uri, toPlainConversationSettings(frozen));
      return frozen;
    }
    if (current.status !== 'ok') throw strictConversationSettingsReadError(conversationId, 'llm', current);

    const latest = normalizeConversationLlmSettings(
      conversationId,
      parseConversationLlmSettings(conversationId, uri, current.value)
    );
    const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
    if (configs.some((config) => config.id === latest.activeProviderConfigId)) return latest;

    const global = await loadNormalizedLlmGlobalSettings(paths);
    const globalProviderConfigId = (global.settings as LlmSettingsRecord).activeProviderConfigId;
    const fallback = configs.find((config) => config.id === globalProviderConfigId) ?? configs[0];
    const validConfigIds = new Set(configs.map((config) => config.id));
    const modelOverrides = latest.modelOverrides
      ? Object.fromEntries(Object.entries(latest.modelOverrides).filter(([configId]) => validConfigIds.has(configId)))
      : undefined;
    const repaired = normalizeConversationLlmSettings(conversationId, {
      activeProviderConfigId: fallback?.id ?? '',
      ...(modelOverrides && Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {})
    });
    await writeJson(uri, toPlainConversationSettings(repaired));
    return repaired;
  });
}

function normalizeConversationLlmSettings(
  conversationId: string,
  settings: Partial<ConversationLlmSettingsRecord> | undefined = undefined
): ConversationLlmSettingsRecord {
  const modelOverrides = normalizeModelOverrides(settings?.modelOverrides);
  return {
    conversationId,
    activeProviderConfigId: typeof settings?.activeProviderConfigId === 'string' ? settings.activeProviderConfigId.trim() : '',
    ...(modelOverrides ? { modelOverrides } : {})
  };
}

function normalizeModelOverrides(value: ConversationLlmSettingsRecord['modelOverrides'] | undefined): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, string> = {};
  for (const [rawConfigId, rawModelId] of Object.entries(value)) {
    const configId = rawConfigId.trim();
    const modelId = rawModelId.trim();
    if (configId && modelId) result[configId] = modelId;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}


function parseConversationCommonSettings(conversationId: string, uri: vscode.Uri, value: unknown): ConversationSettingsRecord {
  const record = asPlainObject(value);
  if (!record
    || record.conversationId !== conversationId
    || typeof record.name !== 'string') {
    throw new Error(`Invalid conversation common settings file: ${uri.fsPath}`);
  }
  return { conversationId: record.conversationId, name: record.name };
}

function parseConversationLlmSettings(conversationId: string, uri: vscode.Uri, value: unknown): ConversationLlmSettingsRecord {
  const record = asPlainObject(value);
  if (!record
    || record.conversationId !== conversationId
    || typeof record.activeProviderConfigId !== 'string'
    || (record.modelOverrides !== undefined && !isStringRecord(record.modelOverrides))) {
    throw new Error(`Invalid conversation LLM settings file: ${uri.fsPath}`);
  }
  return {
    conversationId: record.conversationId,
    activeProviderConfigId: record.activeProviderConfigId,
    ...(record.modelOverrides ? { modelOverrides: { ...record.modelOverrides } } : {})
  };
}

function toPlainConversationSettings<T extends ConversationSettingsRecord | ConversationLlmSettingsRecord>(settings: T): T {
  if ('activeProviderConfigId' in settings) {
    const modelOverrides = normalizeModelOverrides(settings.modelOverrides);
    return {
      conversationId: settings.conversationId,
      activeProviderConfigId: settings.activeProviderConfigId,
      ...(modelOverrides ? { modelOverrides } : {})
    } as T;
  }
  return { conversationId: settings.conversationId, name: settings.name } as T;
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  const record = asPlainObject(value);
  return !!record && Object.values(record).every((item) => typeof item === 'string');
}

function strictConversationSettingsReadError(
  conversationId: string,
  section: string,
  result: Exclude<StrictJsonReadResult<unknown>, { status: 'ok' | 'missing' }>
): Error {
  const reason = result.status === 'invalid' ? 'invalid JSON' : 'I/O error';
  const message = result.error instanceof Error ? result.error.message : String(result.error);
  return new Error(`Failed to read conversation settings ${conversationId}/${section} (${reason}): ${result.uri.fsPath}. ${message}`);
}

function applyConversationModelOverride(config: LlmProviderConfigRecord, settings: ConversationLlmSettingsRecord | undefined): LlmProviderConfigRecord {
  const model = settings?.modelOverrides?.[config.id]?.trim();
  if (!model || model === config.model || !modelExistsInConfig(config, model)) return config;
  return { ...config, model };
}

function modelExistsInConfig(config: LlmProviderConfigRecord, model: string): boolean {
  const id = model.trim();
  if (!id) return false;
  return config.model?.trim() === id || config.models.some((candidate) => candidate.id.trim() === id);
}
