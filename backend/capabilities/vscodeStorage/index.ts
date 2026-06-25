import * as vscode from 'vscode';
import type {
  ConversationLlmSettingsRecord,
  ConversationSettingsRecord,
  EditToolMode,
  EditToolStatisticsRecord,
  GlobalSettingsRecord,
  GlobalSettingsSectionValue,
  LlmCompressionConfigsRecord,
  LlmCompressionSettingsRecord,
  LlmProviderConfigsRecord,
  LlmSettingsRecord
} from '../../../shared/protocol';
import type { StorageCapability } from '../types';
import { loadGlobalSettingsFile, writeGlobalSettingsFile } from './globalSettings';
import { loadLlmProviderConfigsSettings, saveLlmProviderConfigsSettings } from './llmProviderConfigs';
import { loadLlmCompressionConfigsSettings, normalizeLlmCompressionSettings, saveLlmCompressionConfigsSettings } from './llmCompressionConfigs';
import {
  createGlobalSettingsRecord,
  LIMCODE_GLOBAL_STATUS_LABEL,
  normalizeStatusDataRootPath,
  resolveDataRootUri,
  saveGlobalStatus
} from './globalStatus';
import { migrateStorageRoot } from './migration';
import { createVscodeStoragePaths } from './paths';
import { readJson, writeJson } from './json';
import {
  appendToolCallEventRecord,
  loadClientStateSkeletonFromStores,
  loadConversationDetailFromStores,
  loadConversationLatestMessagesFromStores,
  loadConversationMessagesByIdsFromStores,
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
  saveToolCallRecord
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

export function createVsCodeStorageCapability(context: vscode.ExtensionContext): StorageCapability {
  let currentPaths = createVscodeStoragePaths(resolveDataRootUri(context));
  registerShadowDiffProvider(context);

  function getPaths(): StoragePaths {
    currentPaths = createVscodeStoragePaths(resolveDataRootUri(context));
    return currentPaths;
  }


  async function loadCommonGlobalSettings(): Promise<{ section: 'common'; settings: GlobalSettingsRecord; filePath: string }> {
    return { section: 'common', settings: createGlobalSettingsRecord(context), filePath: LIMCODE_GLOBAL_STATUS_LABEL };
  }

  async function saveCommonGlobalSettings(settings: GlobalSettingsSectionValue): Promise<{ section: 'common'; settings: GlobalSettingsRecord; filePath: string }> {
    const input = settings as Partial<GlobalSettingsRecord> | undefined;
    const previousPaths = getPaths();
    const targetDataRootPath = normalizeStatusDataRootPath(context, input?.dataFilePath ?? '');
    const targetRootUri = resolveDataRootUri(context, targetDataRootPath);
    const migration = await migrateStorageRoot(previousPaths.globalStorageUri, targetRootUri);
    await saveGlobalStatus(context, targetDataRootPath, migration.skipped ? undefined : { fromPath: migration.fromPath, toPath: migration.toPath, migratedAt: migration.migratedAt });
    return loadCommonGlobalSettings();
  }

  async function loadNormalizedLlmGlobalSettings(paths: StoragePaths): Promise<{ section: 'llm'; settings: LlmSettingsRecord; filePath: string }> {
    await ensureLlmSettingsRoots(paths);
    const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
    const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llm');
    const settings = stored.settings as LlmSettingsRecord;
    const activeConfig = configs.find((config) => config.id === settings.activeProviderConfigId) ?? configs[0];
    const normalized: LlmSettingsRecord = { activeProviderConfigId: activeConfig?.id ?? '' };
    if (settings.activeProviderConfigId !== normalized.activeProviderConfigId) {
      await writeGlobalSettingsFile(paths.settingsRootUri, 'llm', normalized);
      return loadGlobalSettingsFile(paths.settingsRootUri, 'llm') as Promise<{ section: 'llm'; settings: LlmSettingsRecord; filePath: string }>;
    }
    return stored as { section: 'llm'; settings: LlmSettingsRecord; filePath: string };
  }

  async function saveNormalizedLlmGlobalSettings(paths: StoragePaths, settings: GlobalSettingsSectionValue): Promise<{ section: 'llm'; settings: LlmSettingsRecord; filePath: string }> {
    await ensureLlmSettingsRoots(paths);
    const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
    const input = settings as Partial<LlmSettingsRecord> | undefined;
    const activeConfig = configs.find((config) => config.id === input?.activeProviderConfigId) ?? configs[0];
    await writeGlobalSettingsFile(paths.settingsRootUri, 'llm', { activeProviderConfigId: activeConfig?.id ?? '' });
    return loadNormalizedLlmGlobalSettings(paths);
  }

  async function ensureLlmSettingsRoots(paths: StoragePaths): Promise<void> {
    await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
  }

  return {
    get paths() { return getPaths(); },
    async ensureReady() {
      // 读路径懒加载：启动阶段不预创建/读取 settings，避免阻塞侧边栏首屏。
    },
    async loadClientStateSkeleton(options) {
      const paths = getPaths();
      return loadClientStateSkeletonFromStores(paths, options);
    },
    async loadConversationDetail(conversationId, options) {
      const paths = getPaths();
      const includeRunHistory = options?.includeRunHistory ?? false;
      return loadConversationDetailFromStores(paths, conversationId, { includeRunHistory });
    },
    async loadConversationTimelineProjectionContext(conversationId, projectionKey, chunkId) {
      const paths = getPaths();
      return loadTimelineProjectionContext(paths, conversationId, projectionKey, chunkId);
    },
    async loadConversationTimelinePage(request) {
      const paths = getPaths();
      return loadConversationTimelinePageFromStores(paths, request);
    },
    async loadConversationLatestMessages(conversationId, limit) {
      const paths = getPaths();
      return loadConversationLatestMessagesFromStores(paths, conversationId, limit);
    },
    async loadConversationMessagesByIds(conversationId, messageIds) {
      const paths = getPaths();
      return loadConversationMessagesByIdsFromStores(paths, conversationId, messageIds);
    },
    async loadConversationTimelineRange(request) {
      const paths = getPaths();
      return loadConversationTimelineRangeFromStores(paths, request);
    },
    async saveClientStateSkeleton(state) {
      const paths = getPaths();
      await saveClientStateSkeletonToStores(paths, state);
    },
    async saveConversationRenderDetail(conversationId, state) {
      const paths = getPaths();
      await saveConversationRenderDetailToStores(paths, conversationId, state);
    },
    async saveConversationRunHistory(conversationId, state, options) {
      const paths = getPaths();
      await saveConversationRunHistoryToStores(paths, conversationId, state, options);
    },
    async loadConversationRunHistoryPage(request) {
      const paths = getPaths();
      return loadConversationRunHistoryPageFromStores(paths, request);
    },
    async loadConversationRunDetail(request) {
      const paths = getPaths();
      return loadConversationRunDetailFromStores(paths, request);
    },
    async resolveConversationRunIdForMessage(conversationId, messageId) {
      const paths = getPaths();
      return resolveConversationRunIdForMessageFromStores(paths, conversationId, messageId);
    },
    async loadConversationHistoryPage(request) {
      const paths = getPaths();
      return loadConversationHistoryPageFromStore(paths, request);
    },
    async upsertConversationHistoryEntry(entry) {
      const paths = getPaths();
      await upsertConversationHistoryEntryInStore(paths, entry);
    },
    async removeConversationHistoryEntry(conversationId) {
      const paths = getPaths();
      await removeConversationHistoryEntryFromStore(paths, conversationId);
    },
    async saveMessageSnapshot(conversationId, message) {
      const paths = getPaths();
      await saveMessageRecord(paths, conversationId, message);
    },
    async removeMessage(_conversationId, messageId) {
      const paths = getPaths();
      await removeMessageRecord(paths, _conversationId, messageId);
    },
    async saveToolCallSnapshot(_conversationId, toolCall) {
      const paths = getPaths();
      await saveToolCallRecord(paths, _conversationId, toolCall);
    },
    async appendToolCallEvent(_conversationId, event) {
      const paths = getPaths();
      await appendToolCallEventRecord(paths, _conversationId, event);
    },
    async detectSystemGit() {
      return detectSystemGitCommand();
    },
    async createShadowCheckpoint(request) {
      const paths = getPaths();
      return createShadowCheckpoint(paths, request);
    },
    async restoreShadowCheckpoint(request) {
      const paths = getPaths();
      return restoreShadowCheckpoint(paths, request);
    },
    async openShadowCheckpointDiff(request) {
      const paths = getPaths();
      return openShadowCheckpointDiff(paths, request);
    },
    async loadEditToolStatistics() {
      const paths = getPaths();
      return loadEditToolStatistics(paths);
    },
    async recordEditToolModeResult(mode, success) {
      const paths = getPaths();
      return recordEditToolModeResult(paths, mode, success);
    },
    async collectShadowWorktreeStats() {
      const paths = getPaths();
      return collectShadowWorktreeStats(paths);
    },
    async deleteShadowWorktrees(storageKeys) {
      const paths = getPaths();
      return deleteShadowWorktrees(paths, storageKeys);
    },
    async cleanupUnusedShadowWorktrees(maxAgeDays) {
      const paths = getPaths();
      return cleanupUnusedShadowWorktrees(paths, maxAgeDays);
    },
    async loadGlobalSettings(section) {
      if (section === 'common') return loadCommonGlobalSettings();
      const paths = getPaths();
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
        if (JSON.stringify(settings) !== JSON.stringify(stored.settings)) await writeGlobalSettingsFile(paths.settingsRootUri, 'llmCompression', settings);
        return { section, settings, filePath: stored.filePath };
      }
      if (section === 'llmCompressionConfigs') {
        const stored = await loadLlmCompressionConfigsSettings(paths);
        return { section, settings: stored.settings, filePath: stored.filePath };
      }
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      return loadGlobalSettingsFile(paths.settingsRootUri, section);
    },
    async saveGlobalSettings(section, settings) {
      if (section === 'common') return saveCommonGlobalSettings(settings);
      const paths = getPaths();
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
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      await writeGlobalSettingsFile(paths.settingsRootUri, section, settings);
      return loadGlobalSettingsFile(paths.settingsRootUri, section);
    },
    async loadActiveLlmProviderConfig(conversationId) {
      const paths = getPaths();
      await ensureLlmSettingsRoots(paths);
      const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
      if (conversationId) {
        const conversationSettings = await this.loadConversationSettings(conversationId, 'llm');
        const activeProviderConfigId = (conversationSettings?.settings as ConversationLlmSettingsRecord | undefined)?.activeProviderConfigId;
        const conversationConfig = activeProviderConfigId ? configs.find((config) => config.id === activeProviderConfigId) : undefined;
        if (conversationConfig) return conversationConfig;
      }
      const stored = await loadNormalizedLlmGlobalSettings(paths);
      const activeConfigId = (stored.settings as LlmSettingsRecord).activeProviderConfigId;
      return configs.find((config) => config.id === activeConfigId) ?? configs[0]!;
    },
    async loadLlmProviderConfigById(configId) {
      const id = configId.trim();
      if (!id) return undefined;
      const paths = getPaths();
      await ensureLlmSettingsRoots(paths);
      return (await loadLlmProviderConfigsSettings(paths)).settings.configs.find((config) => config.id === id);
    },
    async loadActiveLlmCompressionConfig(providerConfigId) {
      const paths = getPaths();
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
      const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llmCompression');
      const settings = normalizeLlmCompressionSettings(stored.settings as Partial<LlmCompressionSettingsRecord> | undefined, configs);
      const binding = providerConfigId
        ? settings.providerBindings.find((candidate) => candidate.providerConfigId === providerConfigId)
        : undefined;
      const id = binding?.compressionConfigId ?? settings.defaultConfigId ?? configs[0]?.id;
      return configs.find((config) => config.id === id) ?? configs[0];
    },
    async loadLlmCompressionConfigById(configId) {
      const id = configId.trim();
      if (!id) return undefined;
      const paths = getPaths();
      return (await loadLlmCompressionConfigsSettings(paths)).settings.configs.find((config) => config.id === id);
    },
    async loadConversationSettings(conversationId, section) {
      const paths = getPaths();
      const uri = conversationSettingsUri(paths, conversationId, section);
      if (section === 'llm') {
        const settings = await readJson<ConversationLlmSettingsRecord>(uri);
        return settings
          ? { conversationId, section, settings: normalizeConversationLlmSettings(conversationId, settings), filePath: uri.fsPath }
          : { conversationId, section, settings: normalizeConversationLlmSettings(conversationId), filePath: uri.fsPath };
      }
      const settings = await readJson<ConversationSettingsRecord>(uri);
      return settings ? { conversationId, section, settings: normalizeConversationCommonSettings(conversationId, settings), filePath: uri.fsPath } : undefined;
    },
    async saveConversationSettings(section, settings) {
      const paths = getPaths();
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      const conversationId = (settings as ConversationSettingsRecord | ConversationLlmSettingsRecord).conversationId;
      const normalized = section === 'llm'
        ? normalizeConversationLlmSettings(conversationId, settings as Partial<ConversationLlmSettingsRecord>)
        : normalizeConversationCommonSettings(conversationId, settings as Partial<ConversationSettingsRecord>);
      const uri = conversationSettingsUri(paths, conversationId, section);
      await writeJson(uri, normalized);
      return { conversationId, section, settings: normalized, filePath: uri.fsPath };
    }
  };
}

function conversationSettingsUri(paths: StoragePaths, conversationId: string, section: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.settingsRootUri, `conversation-${safeFileName(conversationId)}-${section}.json`);
}

function safeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function normalizeConversationCommonSettings(conversationId: string, settings: Partial<ConversationSettingsRecord> | undefined): ConversationSettingsRecord {
  return { conversationId, name: typeof settings?.name === 'string' ? settings.name : '' };
}

function normalizeConversationLlmSettings(
  conversationId: string,
  settings: Partial<ConversationLlmSettingsRecord> | undefined = undefined
): ConversationLlmSettingsRecord {
  return { conversationId, activeProviderConfigId: typeof settings?.activeProviderConfigId === 'string' ? settings.activeProviderConfigId.trim() : '' };
}

function editToolStatisticsUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.settingsRootUri, 'edit-tool-statistics.json');
}

async function loadEditToolStatistics(paths: StoragePaths): Promise<EditToolStatisticsRecord> {
  return normalizeEditToolStatistics(await readJson<Partial<EditToolStatisticsRecord>>(editToolStatisticsUri(paths)));
}

async function recordEditToolModeResult(paths: StoragePaths, mode: EditToolMode, success: boolean): Promise<EditToolStatisticsRecord> {
  await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
  const uri = editToolStatisticsUri(paths);
  const current = normalizeEditToolStatistics(await readJson<Partial<EditToolStatisticsRecord>>(uri));
  const previous = current.modes[mode];
  const attempts = previous.attempts + 1;
  const successes = previous.successes + (success ? 1 : 0);
  const failures = previous.failures + (success ? 0 : 1);
  const now = Date.now();
  const next: EditToolStatisticsRecord = {
    modes: {
      ...current.modes,
      [mode]: normalizeEditModeStatistics({ mode, attempts, successes, failures, updatedAt: now })
    },
    updatedAt: now
  };
  await writeJson(uri, next);
  return next;
}

function normalizeEditToolStatistics(input: Partial<EditToolStatisticsRecord> | undefined): EditToolStatisticsRecord {
  const now = Date.now();
  return {
    modes: {
      patch: normalizeEditModeStatistics({ mode: 'patch', ...(input?.modes?.patch ?? {}) }),
      hunk: normalizeEditModeStatistics({ mode: 'hunk', ...(input?.modes?.hunk ?? {}) })
    },
    updatedAt: finiteNonNegativeInteger(input?.updatedAt, now)
  };
}

function normalizeEditModeStatistics(input: Partial<EditToolStatisticsRecord['modes'][EditToolMode]> & { mode: EditToolMode }): EditToolStatisticsRecord['modes'][EditToolMode] {
  const attempts = finiteNonNegativeInteger(input.attempts, 0);
  const successes = Math.min(attempts, finiteNonNegativeInteger(input.successes, 0));
  const failures = Math.max(0, attempts - successes);
  return { mode: input.mode, attempts, successes, failures, successRate: attempts > 0 ? successes / attempts : 0, ...(input.updatedAt !== undefined ? { updatedAt: finiteNonNegativeInteger(input.updatedAt, Date.now()) } : {}) };
}

function finiteNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}