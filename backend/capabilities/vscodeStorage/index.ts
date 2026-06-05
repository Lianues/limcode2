import * as vscode from 'vscode';
import type { ConversationSettingsRecord, GlobalSettingsRecord, GlobalSettingsSectionValue } from '../../../shared/protocol';
import type { StorageCapability } from '../types';
import { ensureGlobalSettingsFile, loadGlobalSettingsFile, writeGlobalSettingsFile } from './globalSettings';
import {
  createGlobalSettingsRecord,
  LIMCODE_GLOBAL_STATUS_LABEL,
  normalizeStatusDataRootPath,
  resolveDataRootUri,
  saveGlobalStatus
} from './globalStatus';
import { migrateStorageRoot } from './migration';
import { createVscodeStoragePaths, ensureStorageRoots } from './paths';
import { readJson, writeJson } from './json';
import {
  appendToolCallEventRecord,
  loadClientStateSkeletonFromStores,
  loadConversationDetailFromStores,
  removeMessageRecord,
  saveClientStateSkeletonToStores,
  saveConversationDetailToStores,
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

  function structuralRoots(paths: StoragePaths): vscode.Uri[] {
    return [
      paths.agentsRootUri,
      paths.agentModesRootUri,
      paths.toolPoliciesRootUri,
      paths.approvalPoliciesRootUri,
      paths.systemPromptsRootUri,
      paths.modelProfilesRootUri,
      paths.conversationsRootUri,
      paths.conversationHistoryRootUri,
      paths.projectContextsRootUri,
      paths.conversationProjectLinksRootUri,
      paths.linksRootUri,
      paths.agentModeLinksRootUri,
      paths.modeToolPolicyLinksRootUri,
      paths.modeApprovalPolicyLinksRootUri,
      paths.modeSystemPromptLinksRootUri,
      paths.modeModelProfileLinksRootUri,
      paths.agentRunsRootUri,
      paths.agentRunSourceLinksRootUri,
      paths.agentRunTargetLinksRootUri,
      paths.messageRunLinksRootUri,
      paths.toolCallRunLinksRootUri,
      paths.runPoliciesRootUri
    ];
  }

  async function ensureReadyFor(paths: StoragePaths): Promise<void> {
    await ensureStorageRoots(...structuralRoots(paths), paths.settingsRootUri);
    await ensureGlobalSettingsFile(paths.settingsRootUri, 'llm');
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
    const nextPaths = getPaths();
    await ensureReadyFor(nextPaths);
    return loadCommonGlobalSettings();
  }

  return {
    get paths() { return getPaths(); },
    async ensureReady() { await ensureReadyFor(getPaths()); },
    async loadClientStateSkeleton() {
      const paths = getPaths();
      await ensureReadyFor(paths);
      return loadClientStateSkeletonFromStores(paths);
    },
    async loadConversationDetail(conversationId) {
      const paths = getPaths();
      await ensureReadyFor(paths);
      return loadConversationDetailFromStores(paths, conversationId);
    },
    async saveClientStateSkeleton(state) {
      const paths = getPaths();
      await ensureReadyFor(paths);
      await saveClientStateSkeletonToStores(paths, state);
    },
    async saveConversationDetail(conversationId, state) {
      const paths = getPaths();
      await ensureReadyFor(paths);
      await saveConversationDetailToStores(paths, conversationId, state);
    },
    async loadConversationHistoryPage(request) {
      const paths = getPaths();
      await ensureReadyFor(paths);
      return loadConversationHistoryPageFromStore(paths, request);
    },
    async upsertConversationHistoryEntry(entry) {
      const paths = getPaths();
      await ensureReadyFor(paths);
      await upsertConversationHistoryEntryInStore(paths, entry);
    },
    async removeConversationHistoryEntry(conversationId) {
      const paths = getPaths();
      await ensureReadyFor(paths);
      await removeConversationHistoryEntryFromStore(paths, conversationId);
    },
    async saveMessageSnapshot(conversationId, message) {
      const paths = getPaths();
      await ensureReadyFor(paths);
      await saveMessageRecord(paths, conversationId, message);
    },
    async removeMessage(_conversationId, messageId) {
      const paths = getPaths();
      await ensureReadyFor(paths);
      await removeMessageRecord(paths, _conversationId, messageId);
    },
    async saveToolCallSnapshot(_conversationId, toolCall) {
      const paths = getPaths();
      await ensureReadyFor(paths);
      await saveToolCallRecord(paths, _conversationId, toolCall);
    },
    async appendToolCallEvent(_conversationId, event) {
      const paths = getPaths();
      await ensureReadyFor(paths);
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