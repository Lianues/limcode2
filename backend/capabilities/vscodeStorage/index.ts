import * as vscode from 'vscode';
import { GLOBAL_SETTINGS_SECTIONS, type ClientState } from '../../../shared/protocol';
import type { StorageCapability } from '../types';
import { loadAgents, saveAgents } from './agents';
import {
  loadConversationSettings,
  loadConversations,
  saveConversationSettings,
  saveConversations
} from './conversations';
import { ensureGlobalSettingsFile, loadGlobalSettingsFile, writeGlobalSettingsFile } from './globalSettings';
import { loadLinks, saveLinks } from './links';
import { createVscodeStoragePaths, ensureStorageRoots } from './paths';

export function createVsCodeStorageCapability(context: vscode.ExtensionContext): StorageCapability {
  const paths = createVscodeStoragePaths(context.globalStorageUri);

  return {
    paths,
    async ensureReady() {
      await ensureStorageRoots(
        paths.agentsRootUri,
        paths.conversationsRootUri,
        paths.linksRootUri,
        paths.settingsRootUri
      );
      await Promise.all(
        GLOBAL_SETTINGS_SECTIONS.map((section) => ensureGlobalSettingsFile(paths.settingsRootUri, section))
      );
    },
    async loadClientState() {
      await ensureStorageRoots(paths.agentsRootUri, paths.conversationsRootUri, paths.linksRootUri);

      const [agents, sessionsAndMessages, agentConversationLinks] = await Promise.all([
        loadAgents(paths.agentsRootUri, paths.agentsIndexUri),
        loadConversations(paths.conversationsRootUri, paths.conversationsIndexUri),
        loadLinks(paths.linksRootUri, paths.linksIndexUri)
      ]);

      if (!agents && !sessionsAndMessages && !agentConversationLinks) return undefined;

      return {
        agents: agents ?? [],
        sessions: sessionsAndMessages?.sessions ?? [],
        agentConversationLinks: agentConversationLinks ?? [],
        messages: sessionsAndMessages?.messages ?? [],
        toolCalls: sessionsAndMessages?.toolCalls ?? []
      } satisfies ClientState;
    },
    async saveClientState(state) {
      await ensureStorageRoots(paths.agentsRootUri, paths.conversationsRootUri, paths.linksRootUri);
      await Promise.all([
        saveAgents(paths.agentsRootUri, paths.agentsIndexUri, state.agents),
        saveConversations(paths.conversationsRootUri, paths.conversationsIndexUri, state.sessions, state.messages, state.toolCalls),
        saveLinks(paths.linksRootUri, paths.linksIndexUri, state.agentConversationLinks)
      ]);
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
