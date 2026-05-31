import * as vscode from 'vscode';
import {
  GLOBAL_SETTINGS_SECTIONS,
  type AgentModeLinkRecord,
  type AgentModeRecord,
  type ClientState,
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
import { loadLinks, saveLinks } from './links';
import { createVscodeStoragePaths, ensureStorageRoots } from './paths';
import { loadRecordStore, saveRecordStore } from './recordStore';

export function createVsCodeStorageCapability(context: vscode.ExtensionContext): StorageCapability {
  const paths = createVscodeStoragePaths(context.globalStorageUri);

  const structuralRoots = [
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

  return {
    paths,
    async ensureReady() {
      await ensureStorageRoots(...structuralRoots, paths.settingsRootUri);
      await Promise.all(
        GLOBAL_SETTINGS_SECTIONS.map((section) => ensureGlobalSettingsFile(paths.settingsRootUri, section))
      );
    },
    async loadClientState() {
      await ensureStorageRoots(...structuralRoots);

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
      await ensureStorageRoots(...structuralRoots);
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
      await ensureStorageRoots(paths.conversationsRootUri);
      return saveStoredMessageSnapshot(paths.conversationsRootUri, paths.conversationsIndexUri, sessionId, message);
    },
    async removeMessage(sessionId, messageId) {
      await ensureStorageRoots(paths.conversationsRootUri);
      return removeStoredMessage(paths.conversationsRootUri, paths.conversationsIndexUri, sessionId, messageId);
    },
    async saveToolCallSnapshot(sessionId, toolCall) {
      await ensureStorageRoots(paths.conversationsRootUri);
      return saveStoredToolCallSnapshot(paths.conversationsRootUri, paths.conversationsIndexUri, sessionId, toolCall);
    },
    async appendToolCallEvent(sessionId, event) {
      await ensureStorageRoots(paths.conversationsRootUri);
      return appendStoredToolCallEvent(paths.conversationsRootUri, paths.conversationsIndexUri, sessionId, event);
    },
    async loadGlobalSettings(section) {
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      return loadGlobalSettingsFile(paths.settingsRootUri, section);
    },
    async saveGlobalSettings(section, settings) {
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      await writeGlobalSettingsFile(paths.settingsRootUri, section, settings);
      return loadGlobalSettingsFile(paths.settingsRootUri, section);
    },
    async loadConversationSettings(sessionId, section) {
      await ensureStorageRoots(paths.conversationsRootUri);
      return loadConversationSettings(paths.conversationsRootUri, paths.conversationsIndexUri, sessionId, section);
    },
    async saveConversationSettings(section, settings) {
      await ensureStorageRoots(paths.conversationsRootUri);
      return saveConversationSettings(paths.conversationsRootUri, paths.conversationsIndexUri, section, settings);
    }
  };
}
