import * as vscode from 'vscode';
import type {
  ConversationSettingsRecord,
  GlobalSettingsRecord,
  GlobalSettingsSectionValue
} from '../../../shared/protocol';
import type { StorageCapability } from '../types';
import { loadGlobalSettingsFile, writeGlobalSettingsFile } from './globalSettings';
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
  loadConversationRunDetailFromStores,
  loadConversationRunHistoryPageFromStores,
  resolveConversationRunIdForMessageFromStores,
  removeMessageRecord,
  saveClientStateSkeletonToStores,
  saveConversationRenderDetailToStores,
  saveConversationRunHistoryToStores,
  saveMessageRecord,
  saveToolCallRecord
} from './clientStateStore';
import {
  loadConversationHistoryPageFromStore,
  removeConversationHistoryEntryFromStore,
  upsertConversationHistoryEntryInStore
} from './conversationHistoryStore';

type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;

export function createVsCodeStorageCapability(context: vscode.ExtensionContext): StorageCapability {
  let currentPaths = createVscodeStoragePaths(resolveDataRootUri(context));

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

  return {
    get paths() { return getPaths(); },
    async ensureReady() {
      // 读路径懒加载：启动阶段不预创建/读取 settings，避免阻塞侧边栏首屏。
    },
    async loadClientStateSkeleton() {
      const paths = getPaths();
      return loadClientStateSkeletonFromStores(paths);
    },
    async loadConversationDetail(conversationId, options) {
      const paths = getPaths();
      const includeRunHistory = options?.includeRunHistory ?? false;
      return loadConversationDetailFromStores(paths, conversationId, { includeRunHistory });
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
    async loadGlobalSettings(section) {
      if (section === 'common') return loadCommonGlobalSettings();
      const paths = getPaths();
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      return loadGlobalSettingsFile(paths.settingsRootUri, section);
    },
    async saveGlobalSettings(section, settings) {
      if (section === 'common') return saveCommonGlobalSettings(settings);
      const paths = getPaths();
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      await writeGlobalSettingsFile(paths.settingsRootUri, section, settings);
      return loadGlobalSettingsFile(paths.settingsRootUri, section);
    },
    async loadConversationSettings(conversationId, section) {
      const paths = getPaths();
      const uri = conversationSettingsUri(paths, conversationId, section);
      const settings = await readJson<ConversationSettingsRecord>(uri);
      return settings ? { conversationId, section, settings, filePath: uri.fsPath } : undefined;
    },
    async saveConversationSettings(section, settings) {
      const paths = getPaths();
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      const conversationId = (settings as ConversationSettingsRecord).conversationId;
      const normalized: ConversationSettingsRecord = { conversationId, name: (settings as ConversationSettingsRecord).name };
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