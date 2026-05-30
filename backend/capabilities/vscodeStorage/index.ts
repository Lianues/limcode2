import * as vscode from 'vscode';
import type { ClientState } from '../../../shared/protocol';
import type { StorageCapability } from '../types';
import { loadAgents, saveAgents } from './agents';
import { loadConversations, saveConversations } from './conversations';
import { ensureLlmSettingsFile, loadLlmSettingsFile, normalizeLlmSettings, writeLlmSettingsFile } from './llmSettings';
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
      await ensureLlmSettingsFile(paths.llmSettingsUri);
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
    async loadLlmSettings() {
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      return loadLlmSettingsFile(paths.llmSettingsUri);
    },
    async saveLlmSettings(settings) {
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      const normalized = normalizeLlmSettings(settings);
      await writeLlmSettingsFile(paths.llmSettingsUri, normalized);
      return normalized;
    }
  };
}
