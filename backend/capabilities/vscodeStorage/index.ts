import * as vscode from 'vscode';
import {
  type AgentModeLinkRecord,
  type AgentModeRecord,
  type ClientState,
  type GlobalSettingsRecord,
  type GlobalSettingsSectionValue,
  type ModeModelProfileLinkRecord,
  type ModeSystemPromptLinkRecord,
  type ModeToolPolicyLinkRecord,
  type ModelProfileRecord,
  type SystemPromptRecord,
  type ToolPolicyRecord
} from '../../../shared/protocol';
import type { StorageCapability } from '../types';
import { loadAgents, saveAgents } from './agents';
import {
  loadConversationSettings,
  loadConversations,
  appendToolCallEvent as appendStoredToolCallEvent,
  removeMessage as removeStoredMessage,
  saveConversationSettings,
  saveConversations,
  saveMessageSnapshot as saveStoredMessageSnapshot,
  saveToolCallSnapshot as saveStoredToolCallSnapshot
} from './conversations';
import { ensureGlobalSettingsFile, loadGlobalSettingsFile, writeGlobalSettingsFile } from './globalSettings';
import {
  createGlobalSettingsRecord,
  LIMCODE_GLOBAL_STATUS_LABEL,
  normalizeStatusDataRootPath,
  resolveDataRootUri,
  saveGlobalStatus
} from './globalStatus';
import { loadLinks, saveLinks } from './links';
import { migrateStorageRoot } from './migration';
import { createVscodeStoragePaths, ensureStorageRoots } from './paths';
import { loadRecordStore, saveRecordStore } from './recordStore';

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
      paths.systemPromptsRootUri,
      paths.modelProfilesRootUri,
      paths.conversationsRootUri,
      paths.linksRootUri,
      paths.agentModeLinksRootUri,
      paths.modeToolPolicyLinksRootUri,
      paths.modeSystemPromptLinksRootUri,
      paths.modeModelProfileLinksRootUri
    ];
  }

  async function ensureReadyFor(paths: StoragePaths): Promise<void> {
    await ensureStorageRoots(...structuralRoots(paths), paths.settingsRootUri);
    await ensureGlobalSettingsFile(paths.settingsRootUri, 'llm');
  }

  async function loadCommonGlobalSettings(): Promise<{ section: 'common'; settings: GlobalSettingsRecord; filePath: string }> {
    return {
      section: 'common',
      settings: createGlobalSettingsRecord(context),
      filePath: LIMCODE_GLOBAL_STATUS_LABEL
    };
  }

  async function saveCommonGlobalSettings(settings: GlobalSettingsSectionValue): Promise<{ section: 'common'; settings: GlobalSettingsRecord; filePath: string }> {
    const input = settings as Partial<GlobalSettingsRecord> | undefined;
    const previousPaths = getPaths();
    const targetDataRootPath = normalizeStatusDataRootPath(context, input?.dataFilePath ?? '');
    const targetRootUri = resolveDataRootUri(context, targetDataRootPath);
    const migration = await migrateStorageRoot(previousPaths.globalStorageUri, targetRootUri);

    await saveGlobalStatus(
      context,
      targetDataRootPath,
      migration.skipped ? undefined : {
        fromPath: migration.fromPath,
        toPath: migration.toPath,
        migratedAt: migration.migratedAt
      }
    );

    const nextPaths = getPaths();
    await ensureReadyFor(nextPaths);
    return loadCommonGlobalSettings();
  }

  return {
    get paths() {
      return getPaths();
    },
    async ensureReady() {
      await ensureReadyFor(getPaths());
    },
    async loadClientState() {
      const paths = getPaths();
      await ensureStorageRoots(...structuralRoots(paths));

      const [
        agents,
        agentModes,
        toolPolicies,
        systemPrompts,
        modelProfiles,
        sessionsAndMessages,
        agentConversationLinks,
        agentModeLinks,
        modeToolPolicyLinks,
        modeSystemPromptLinks,
        modeModelProfileLinks
      ] = await Promise.all([
        loadAgents(paths.agentsRootUri, paths.agentsIndexUri),
        loadRecordStore<AgentModeRecord, 'agentMode'>(paths.agentModesRootUri, paths.agentModesIndexUri, 'agentMode'),
        loadRecordStore<ToolPolicyRecord, 'toolPolicy'>(paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri, 'toolPolicy'),
        loadRecordStore<SystemPromptRecord, 'systemPrompt'>(paths.systemPromptsRootUri, paths.systemPromptsIndexUri, 'systemPrompt'),
        loadRecordStore<ModelProfileRecord, 'modelProfile'>(paths.modelProfilesRootUri, paths.modelProfilesIndexUri, 'modelProfile'),
        loadConversations(paths.conversationsRootUri, paths.conversationsIndexUri),
        loadLinks(paths.linksRootUri, paths.linksIndexUri),
        loadRecordStore<AgentModeLinkRecord, 'agentModeLink'>(paths.agentModeLinksRootUri, paths.agentModeLinksIndexUri, 'agentModeLink'),
        loadRecordStore<ModeToolPolicyLinkRecord, 'modeToolPolicyLink'>(paths.modeToolPolicyLinksRootUri, paths.modeToolPolicyLinksIndexUri, 'modeToolPolicyLink'),
        loadRecordStore<ModeSystemPromptLinkRecord, 'modeSystemPromptLink'>(paths.modeSystemPromptLinksRootUri, paths.modeSystemPromptLinksIndexUri, 'modeSystemPromptLink'),
        loadRecordStore<ModeModelProfileLinkRecord, 'modeModelProfileLink'>(paths.modeModelProfileLinksRootUri, paths.modeModelProfileLinksIndexUri, 'modeModelProfileLink')
      ]);

      if (
        !agents
        && !agentModes
        && !toolPolicies
        && !systemPrompts
        && !modelProfiles
        && !sessionsAndMessages
        && !agentConversationLinks
        && !agentModeLinks
        && !modeToolPolicyLinks
        && !modeSystemPromptLinks
        && !modeModelProfileLinks
      ) return undefined;

      return {
        agents: agents ?? [],
        agentModes: agentModes ?? [],
        toolPolicies: toolPolicies ?? [],
        systemPrompts: systemPrompts ?? [],
        modelProfiles: modelProfiles ?? [],
        agentModeLinks: agentModeLinks ?? [],
        modeToolPolicyLinks: modeToolPolicyLinks ?? [],
        modeSystemPromptLinks: modeSystemPromptLinks ?? [],
        modeModelProfileLinks: modeModelProfileLinks ?? [],
        sessions: sessionsAndMessages?.sessions ?? [],
        agentConversationLinks: agentConversationLinks ?? [],
        messages: sessionsAndMessages?.messages ?? [],
        toolCalls: sessionsAndMessages?.toolCalls ?? [],
        toolCallEvents: sessionsAndMessages?.toolCallEvents ?? []
      } satisfies ClientState;
    },
    async saveClientState(state) {
      const paths = getPaths();
      await ensureStorageRoots(...structuralRoots(paths));
      await Promise.all([
        saveAgents(paths.agentsRootUri, paths.agentsIndexUri, state.agents),
        saveRecordStore(paths.agentModesRootUri, paths.agentModesIndexUri, state.agentModes, 'agentMode', (record) => record.name),
        saveRecordStore(paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri, state.toolPolicies, 'toolPolicy', (record) => record.name),
        saveRecordStore(paths.systemPromptsRootUri, paths.systemPromptsIndexUri, state.systemPrompts, 'systemPrompt', (record) => record.name),
        saveRecordStore(paths.modelProfilesRootUri, paths.modelProfilesIndexUri, state.modelProfiles, 'modelProfile', (record) => record.name),
        saveConversations(paths.conversationsRootUri, paths.conversationsIndexUri, state.sessions, state.messages, state.toolCalls, state.toolCallEvents),
        saveLinks(paths.linksRootUri, paths.linksIndexUri, state.agentConversationLinks),
        saveRecordStore(paths.agentModeLinksRootUri, paths.agentModeLinksIndexUri, state.agentModeLinks, 'agentModeLink', (record) => `${record.role}-${record.agentId}-${record.modeId}`),
        saveRecordStore(paths.modeToolPolicyLinksRootUri, paths.modeToolPolicyLinksIndexUri, state.modeToolPolicyLinks, 'modeToolPolicyLink', (record) => `${record.role}-${record.modeId}-${record.toolPolicyId}`),
        saveRecordStore(paths.modeSystemPromptLinksRootUri, paths.modeSystemPromptLinksIndexUri, state.modeSystemPromptLinks, 'modeSystemPromptLink', (record) => `${record.role}-${record.modeId}-${record.systemPromptId}`),
        saveRecordStore(paths.modeModelProfileLinksRootUri, paths.modeModelProfileLinksIndexUri, state.modeModelProfileLinks, 'modeModelProfileLink', (record) => `${record.role}-${record.modeId}-${record.modelProfileId}`)
      ]);
    },
    async saveMessageSnapshot(sessionId, message) {
      const paths = getPaths();
      await ensureStorageRoots(paths.conversationsRootUri);
      return saveStoredMessageSnapshot(paths.conversationsRootUri, paths.conversationsIndexUri, sessionId, message);
    },
    async removeMessage(sessionId, messageId) {
      const paths = getPaths();
      await ensureStorageRoots(paths.conversationsRootUri);
      return removeStoredMessage(paths.conversationsRootUri, paths.conversationsIndexUri, sessionId, messageId);
    },
    async saveToolCallSnapshot(sessionId, toolCall) {
      const paths = getPaths();
      await ensureStorageRoots(paths.conversationsRootUri);
      return saveStoredToolCallSnapshot(paths.conversationsRootUri, paths.conversationsIndexUri, sessionId, toolCall);
    },
    async appendToolCallEvent(sessionId, event) {
      const paths = getPaths();
      await ensureStorageRoots(paths.conversationsRootUri);
      return appendStoredToolCallEvent(paths.conversationsRootUri, paths.conversationsIndexUri, sessionId, event);
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
    async loadConversationSettings(sessionId, section) {
      const paths = getPaths();
      await ensureStorageRoots(paths.conversationsRootUri);
      return loadConversationSettings(paths.conversationsRootUri, paths.conversationsIndexUri, sessionId, section);
    },
    async saveConversationSettings(section, settings) {
      const paths = getPaths();
      await ensureStorageRoots(paths.conversationsRootUri);
      return saveConversationSettings(paths.conversationsRootUri, paths.conversationsIndexUri, section, settings);
    }
  };
}
