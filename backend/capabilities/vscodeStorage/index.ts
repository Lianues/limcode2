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
import type { DeleteConversationDataResult, StorageCapability } from '../types';
import { loadGlobalSettingsFile, writeGlobalSettingsFile } from './globalSettings';
import { loadLlmProviderConfigsSettings, saveLlmProviderConfigsSettings } from './llmProviderConfigs';
import { loadLlmCompressionConfigsSettings, normalizeLlmCompressionSettings, saveLlmCompressionConfigsSettings } from './llmCompressionConfigs';
import { loadMcpServersSettings, saveMcpServersSettings } from './mcpServers';
import {
  createGlobalSettingsRecord,
  LIMCODE_GLOBAL_STATUS_LABEL,
  normalizeStatusDataRootPath,
  resolveDataRootUri,
  saveGlobalStatus,
  sameFsPath
} from './globalStatus';
import { cleanupMigratedStorageRoot, copyStorageRootForMigration } from './migration';
import { createVscodeStoragePaths } from './paths';
import { readJsonStrict, writeJson, type StrictJsonReadResult } from './json';
import { withStorageResourceLock } from './storageResourceLock';
import {
  assertNoOtherLiveInstanceUsingDataRoot,
  createDataRootProcessLease,
  dataRootMigrationLockUri,
  DATA_ROOT_MIGRATION_OPERATION
} from './dataRootProcessLease';
import {
  materializeAttachmentFileUri as materializeAttachmentFileUriFromStore,
  resolveAttachmentForClient as resolveAttachmentForClientFromStore
} from './attachmentStore';
import {
  appendToolCallEventRecord,
  deleteConversationDataFromStores,
  loadClientStateSkeletonSnapshotFromStores,
  loadConversationDetailFromStores,
  loadConversationRunDetailFromStores,
  loadConversationRunHistoryPageFromStores,
  loadConversationTimelinePageFromStores,
  loadConversationTimelineRangeFromStores,
  resolveConversationRunIdForMessageFromStores,
  removeMessageRecord,
  saveClientStateSkeletonToStores,
  saveConversationRenderDetailToStores,
  saveConversationRunHistoryToStores,
  saveMessageRecord,
  saveToolCallRecord,
  truncateConversationTimelineFromStores
} from './clientStateStore';
import { loadTimelineProjectionContext } from './conversationTimelineStore';
import {
  loadConversationHistoryPageFromStore,
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
  let currentPaths = createVscodeStoragePaths(resolveDataRootUri(context));
  const dataRootGate = new DataRootMutationGate();
  const processLease = createDataRootProcessLease(context, () => resolveDataRootUri(context).fsPath);
  let stagedSkeletonTransactionId: string | undefined;
  processLease.start();
  context.subscriptions.push({ dispose: () => processLease.dispose() });
  registerShadowDiffProvider(context);

  function getPaths(): StoragePaths {
    currentPaths = createVscodeStoragePaths(resolveDataRootUri(context));
    return currentPaths;
  }

  function withSharedDataRoot<T>(action: (paths: StoragePaths) => Promise<T>): Promise<T> {
    return dataRootGate.runShared(async () => {
      await processLease.heartbeat();
      return action(getPaths());
    });
  }

  function withExclusiveDataRoot<T>(action: (paths: StoragePaths) => Promise<T>): Promise<T> {
    return dataRootGate.runExclusive(async () => {
      await processLease.heartbeat();
      return action(getPaths());
    });
  }


  async function loadCommonGlobalSettings(): Promise<{ section: 'common'; settings: GlobalSettingsRecord; filePath: string }> {
    return { section: 'common', settings: createGlobalSettingsRecord(context), filePath: LIMCODE_GLOBAL_STATUS_LABEL };
  }

  async function saveCommonGlobalSettings(settings: GlobalSettingsSectionValue): Promise<{ section: 'common'; settings: GlobalSettingsRecord; filePath: string }> {
    return withExclusiveDataRoot(async () => {
      const input = settings as Partial<GlobalSettingsRecord> | undefined;
      const targetDataRootPath = normalizeStatusDataRootPath(context, input?.dataFilePath ?? '');
      const targetRootUri = resolveDataRootUri(context, targetDataRootPath);
      await processLease.setActiveOperation({ kind: DATA_ROOT_MIGRATION_OPERATION, targetRootPath: targetRootUri.fsPath });
      try {
        return await withStorageResourceLock(dataRootMigrationLockUri(context), async () => {
          const sourceRootUri = resolveDataRootUri(context);
          const migration = await prepareAndRunStorageRootMigration(sourceRootUri, targetRootUri, targetDataRootPath, input?.proxy ?? '');
          await processLease.heartbeat();
          return migration;
        });
      } finally {
        await processLease.clearActiveOperation(DATA_ROOT_MIGRATION_OPERATION);
      }
    });
  }

  async function prepareAndRunStorageRootMigration(
    sourceRootUri: vscode.Uri,
    targetRootUri: vscode.Uri,
    targetDataRootPath: string,
    proxy: string
  ): Promise<{ section: 'common'; settings: GlobalSettingsRecord; filePath: string }> {
    const migration = await copyStorageRootAfterLeaseCheck(sourceRootUri, targetRootUri);
    await saveGlobalStatus(context, targetDataRootPath, proxy, migration.skipped ? undefined : { fromPath: migration.fromPath, toPath: migration.toPath, migratedAt: migration.migratedAt });
    await processLease.heartbeat();
    if (!migration.skipped) {
      const activeRootAfterSave = resolveDataRootUri(context);
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
    return loadCommonGlobalSettings();
  }

  async function copyStorageRootAfterLeaseCheck(sourceRootUri: vscode.Uri, targetRootUri: vscode.Uri) {
    if (!sameFsPath(sourceRootUri.fsPath, targetRootUri.fsPath)) {
      await assertNoOtherLiveInstanceUsingDataRoot(context, processLease.instanceId, sourceRootUri.fsPath);
    }
    return copyStorageRootForMigration(sourceRootUri, targetRootUri);
  }

  async function saveNormalizedLlmGlobalSettings(paths: StoragePaths, settings: GlobalSettingsSectionValue): Promise<{ section: 'llm'; settings: LlmSettingsRecord; filePath: string }> {
    await ensureLlmSettingsRoots(paths);
    const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
    const input = settings as Partial<LlmSettingsRecord> | undefined;
    const activeConfig = configs.find((config) => config.id === input?.activeProviderConfigId) ?? configs[0];
    await writeGlobalSettingsFile(paths.settingsRootUri, 'llm', { activeProviderConfigId: activeConfig?.id ?? '' });
    return loadNormalizedLlmGlobalSettings(paths);
  }

  return {
    get paths() { return getPaths(); },
    isDataRootMutationActive() { return dataRootGate.isExclusiveActive; },
    async ensureReady() {
      return withSharedDataRoot(async () => {
        // 读路径懒加载：启动阶段不预创建/读取 settings，避免阻塞侧边栏首屏。
      });
    },
    async loadClientStateSkeleton(options) {
      return withSharedDataRoot(async (paths) => {
        const profile = options?.profile ?? 'full';
        if (profile === 'startup') {
          const snapshot = await loadClientStateSkeletonSnapshotFromStores(paths, options);
          stagedSkeletonTransactionId = snapshot.transactionId;
          return snapshot.state;
        }
        if (profile === 'deferred') {
          try {
            const snapshot = await loadClientStateSkeletonSnapshotFromStores(paths, options, stagedSkeletonTransactionId);
            return snapshot.state;
          } finally {
            stagedSkeletonTransactionId = undefined;
          }
        }
        return (await loadClientStateSkeletonSnapshotFromStores(paths, options)).state;
      });
    },
    async loadConversationDetail(conversationId, options) {
      return withSharedDataRoot((paths) => {
        const includeRunHistory = options?.includeRunHistory ?? false;
        return loadConversationDetailFromStores(paths, conversationId, { includeRunHistory });
      });
    },
    async loadConversationTimelineProjectionContext(conversationId, projectionKey, chunkId) {
      return withSharedDataRoot((paths) => loadTimelineProjectionContext(paths, conversationId, projectionKey, chunkId));
    },
    async loadConversationTimelinePage(request) {
      return withSharedDataRoot((paths) => loadConversationTimelinePageFromStores(paths, request));
    },
    async loadConversationTimelineRange(request) {
      return withSharedDataRoot((paths) => loadConversationTimelineRangeFromStores(paths, request));
    },
    async truncateConversationTimeline(request) {
      return withSharedDataRoot((paths) => truncateConversationTimelineFromStores(paths, request));
    },
    async saveClientStateSkeleton(state) {
      return withSharedDataRoot(async (paths) => {
        await saveClientStateSkeletonToStores(paths, state);
      });
    },
    async saveConversationRenderDetail(conversationId, state) {
      return withSharedDataRoot(async (paths) => {
        await saveConversationRenderDetailToStores(paths, conversationId, state);
      });
    },
    async saveConversationRunHistory(conversationId, state, options) {
      return withSharedDataRoot(async (paths) => {
        await saveConversationRunHistoryToStores(paths, conversationId, state, options);
      });
    },
    async loadConversationRunHistoryPage(request) {
      return withSharedDataRoot((paths) => loadConversationRunHistoryPageFromStores(paths, request));
    },
    async loadConversationRunDetail(request) {
      return withSharedDataRoot((paths) => loadConversationRunDetailFromStores(paths, request));
    },
    async resolveConversationRunIdForMessage(conversationId, messageId) {
      return withSharedDataRoot((paths) => resolveConversationRunIdForMessageFromStores(paths, conversationId, messageId));
    },
    async loadConversationHistoryPage(request) {
      return withSharedDataRoot((paths) => loadConversationHistoryPageFromStore(paths, request));
    },
    async upsertConversationHistoryEntry(entry, originLink) {
      return withSharedDataRoot(async (paths) => {
        await upsertConversationHistoryEntryInStore(paths, entry, originLink);
      });
    },
    async removeConversationHistoryEntry(conversationId) {
      return withSharedDataRoot(async (paths) => {
        await removeConversationHistoryEntryFromStore(paths, conversationId);
      });
    },
    async deleteConversationData(conversationId) {
      return withSharedDataRoot(async (paths) => {
        const result: DeleteConversationDataResult = await deleteConversationDataFromStores(paths, conversationId);
        await collectDeleteStep(result, () => removeConversationHistoryEntryFromStore(paths, conversationId), `history:${conversationId}`);
        await collectDeleteStep(result, () => vscode.workspace.fs.delete(conversationSettingsUri(paths, conversationId, 'common'), { useTrash: false }), conversationSettingsUri(paths, conversationId, 'common').fsPath, true);
        await collectDeleteStep(result, () => vscode.workspace.fs.delete(conversationSettingsUri(paths, conversationId, 'llm'), { useTrash: false }), conversationSettingsUri(paths, conversationId, 'llm').fsPath, true);
        return { ...result, ok: result.errors.length === 0 };
      });
    },
    async saveMessageSnapshot(conversationId, message) {
      return withSharedDataRoot(async (paths) => {
        await saveMessageRecord(paths, conversationId, message);
      });
    },
    async removeMessage(_conversationId, messageId) {
      return withSharedDataRoot(async (paths) => {
        await removeMessageRecord(paths, _conversationId, messageId);
      });
    },
    async saveToolCallSnapshot(_conversationId, toolCall) {
      return withSharedDataRoot(async (paths) => {
        await saveToolCallRecord(paths, _conversationId, toolCall);
      });
    },
    async appendToolCallEvent(_conversationId, event) {
      return withSharedDataRoot(async (paths) => {
        await appendToolCallEventRecord(paths, _conversationId, event);
      });
    },
    async resolveAttachmentForClient(input) {
      return withSharedDataRoot((paths) => resolveAttachmentForClientFromStore(paths, input));
    },
    async materializeAttachmentFileUri(input) {
      return withSharedDataRoot((paths) => materializeAttachmentFileUriFromStore(paths, input));
    },
    async detectSystemGit() {
      return withSharedDataRoot(async () => detectSystemGitCommand());
    },
    async createShadowCheckpoint(request) {
      return withSharedDataRoot((paths) => createShadowCheckpoint(paths, request));
    },
    async restoreShadowCheckpoint(request) {
      return withSharedDataRoot((paths) => restoreShadowCheckpoint(paths, request));
    },
    async openShadowCheckpointDiff(request) {
      return withSharedDataRoot((paths) => openShadowCheckpointDiff(paths, request));
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
          return { section, settings: stored.settings, filePath: stored.filePath };
        }
        if (section === 'llmCompression') {
          const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
          const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llmCompression');
          const settings = normalizeLlmCompressionSettings(stored.settings as Partial<LlmCompressionSettingsRecord> | undefined, configs);
          return { section, settings, filePath: stored.filePath };
        }
        if (section === 'llmCompressionConfigs') {
          const stored = await loadLlmCompressionConfigsSettings(paths);
          return { section, settings: stored.settings, filePath: stored.filePath };
        }
        if (section === 'mcpServers') {
          const stored = await loadMcpServersSettings(paths);
          return { section, settings: stored.settings, filePath: stored.filePath };
        }
        await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
        return loadGlobalSettingsFile(paths.settingsRootUri, section);
      });
    },
    async saveGlobalSettings(section, settings) {
      if (section === 'common') return saveCommonGlobalSettings(settings);
      return withSharedDataRoot(async (paths) => {
        if (section === 'llm') return saveNormalizedLlmGlobalSettings(paths, settings);
        if (section === 'llmProviderConfigs') {
          const stored = await saveLlmProviderConfigsSettings(paths, settings as Partial<LlmProviderConfigsRecord> | undefined);
          await loadNormalizedLlmGlobalSettings(paths);
          return { section, settings: stored.settings, filePath: stored.filePath };
        }
        if (section === 'llmCompression') {
          const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
          const normalized = normalizeLlmCompressionSettings(settings as Partial<LlmCompressionSettingsRecord> | undefined, configs);
          await writeGlobalSettingsFile(paths.settingsRootUri, 'llmCompression', normalized);
          const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llmCompression');
          return { section, settings: stored.settings, filePath: stored.filePath };
        }
        if (section === 'llmCompressionConfigs') {
          const stored = await saveLlmCompressionConfigsSettings(paths, settings as Partial<LlmCompressionConfigsRecord> | undefined);
          return { section, settings: stored.settings, filePath: stored.filePath };
        }
        if (section === 'mcpServers') {
          const stored = await saveMcpServersSettings(paths, settings as Partial<McpServersSettingsRecord> | undefined);
          return { section, settings: stored.settings, filePath: stored.filePath };
        }
        await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
        await writeGlobalSettingsFile(paths.settingsRootUri, section, settings);
        return loadGlobalSettingsFile(paths.settingsRootUri, section);
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
        await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
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
    async loadConversationSettings(conversationId, section) {
      return withSharedDataRoot(async (paths) => {
        const uri = conversationSettingsUri(paths, conversationId, section);
        const result = await readJsonStrict<unknown>(uri);
        if (section === 'llm') {
          if (result.status === 'missing') {
            const frozen = await freezeMissingConversationLlmSettingsToCurrentGlobal(paths, conversationId, uri);
            return { conversationId, section, settings: frozen, filePath: uri.fsPath };
          }
          if (result.status !== 'ok') throw strictConversationSettingsReadError(conversationId, section, result);
          const settings = parseConversationLlmSettings(conversationId, uri, result.value);
          return { conversationId, section, settings: normalizeConversationLlmSettings(conversationId, settings), filePath: uri.fsPath };
        }
        if (result.status === 'missing') return undefined;
        if (result.status !== 'ok') throw strictConversationSettingsReadError(conversationId, section, result);
        const settings = parseConversationCommonSettings(conversationId, uri, result.value);
        return { conversationId, section, settings: normalizeConversationCommonSettings(conversationId, settings), filePath: uri.fsPath };
      });
    },
    async saveConversationSettings(section, settings) {
      return withSharedDataRoot(async (paths) => {
        await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
        const conversationId = (settings as ConversationSettingsRecord | ConversationLlmSettingsRecord).conversationId;
        const normalized = section === 'llm'
          ? normalizeConversationLlmSettings(conversationId, settings as Partial<ConversationLlmSettingsRecord>)
          : normalizeConversationCommonSettings(conversationId, settings as Partial<ConversationSettingsRecord>);
        const uri = conversationSettingsUri(paths, conversationId, section);
        await withStorageResourceLock(uri, async () => {
          await writeJson(uri, toPlainConversationSettings(normalized));
        });
        return { conversationId, section, settings: toPlainConversationSettings(normalized), filePath: uri.fsPath };
      });
    }
  };
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
  return vscode.Uri.joinPath(paths.settingsRootUri, `conversation-${safeFileName(conversationId)}-${section}.json`);
}

function safeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

async function ensureLlmSettingsRoots(paths: StoragePaths): Promise<void> {
  await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
}

async function loadNormalizedLlmGlobalSettings(paths: StoragePaths): Promise<{ section: 'llm'; settings: LlmSettingsRecord; filePath: string }> {
  await ensureLlmSettingsRoots(paths);
  const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
  const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llm');
  const settings = stored.settings as LlmSettingsRecord;
  const activeConfig = configs.find((config) => config.id === settings.activeProviderConfigId) ?? configs[0];
  const normalized: LlmSettingsRecord = { activeProviderConfigId: activeConfig?.id ?? '' };
  return { section: 'llm', settings: normalized, filePath: stored.filePath };
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
