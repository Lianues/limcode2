import * as vscode from 'vscode';
import type { ClientState, ConversationSettingsRecord, GlobalSettingsRecord, GlobalSettingsSectionValue } from '../../../shared/protocol';
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

const CLIENT_STATE_FILE = 'client-state.json';

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
      paths.runPoliciesRootUri,
      paths.messageRevisionsRootUri
    ];
  }

  async function ensureReadyFor(paths: StoragePaths): Promise<void> {
    await ensureStorageRoots(...structuralRoots(paths), paths.settingsRootUri);
    await ensureGlobalSettingsFile(paths.settingsRootUri, 'llm');
  }

  function clientStateUri(paths: StoragePaths): vscode.Uri {
    return vscode.Uri.joinPath(paths.globalStorageUri, CLIENT_STATE_FILE);
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

  async function loadState(paths: StoragePaths): Promise<ClientState> {
    return (await readJson<ClientState>(clientStateUri(paths))) ?? emptyClientState();
  }

  async function saveState(paths: StoragePaths, state: ClientState): Promise<void> {
    await writeJson(clientStateUri(paths), state);
  }

  return {
    get paths() { return getPaths(); },
    async ensureReady() { await ensureReadyFor(getPaths()); },
    async loadClientState() {
      const paths = getPaths();
      await ensureReadyFor(paths);
      const state = await readJson<ClientState>(clientStateUri(paths));
      return state ?? undefined;
    },
    async saveClientState(state) {
      const paths = getPaths();
      await ensureReadyFor(paths);
      await saveState(paths, state);
    },
    async saveMessageSnapshot(conversationId, message) {
      const paths = getPaths();
      const state = await loadState(paths);
      const normalized = { ...message, conversationId };
      state.messages = upsertById(state.messages, normalized);
      await saveState(paths, state);
    },
    async removeMessage(_conversationId, messageId) {
      const paths = getPaths();
      const state = await loadState(paths);
      state.messages = state.messages.filter((message) => message.id !== messageId);
      await saveState(paths, state);
    },
    async saveToolCallSnapshot(_conversationId, toolCall) {
      const paths = getPaths();
      const state = await loadState(paths);
      state.toolCalls = upsertById(state.toolCalls, toolCall);
      await saveState(paths, state);
    },
    async appendToolCallEvent(_conversationId, event) {
      const paths = getPaths();
      const state = await loadState(paths);
      state.toolCallEvents = upsertById(state.toolCallEvents, event);
      await saveState(paths, state);
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

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function emptyClientState(): ClientState {
  return {
    agents: [], agentModes: [], toolPolicies: [], approvalPolicies: [], systemPrompts: [], modelProfiles: [],
    agentModeLinks: [], modeToolPolicyLinks: [], modeApprovalPolicyLinks: [], modeSystemPromptLinks: [], modeModelProfileLinks: [],
    conversations: [], conversationReuseLinks: [], conversationBranchLinks: [], agentConversationLinks: [], messages: [], messageRevisions: [], messageCurrentRevisionLinks: [],
    toolCalls: [], toolCallEvents: [], agentRuns: [], agentRunSourceLinks: [], agentRunTargetLinks: [], messageRunLinks: [], toolCallRunLinks: [],
    runConversationPolicies: [], runContextPolicies: [], runDeliveryPolicies: [], runEditPolicies: [],
    runModeLinks: [], runSystemPromptLinks: [], runModelProfileLinks: [], runToolPolicyLinks: [], runApprovalPolicyLinks: [],
    runConversationPolicyLinks: [], runContextPolicyLinks: [], runDeliveryPolicyLinks: [], runEditPolicyLinks: [], agentRunInputRevisions: []
  };
}
