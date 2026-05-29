import * as vscode from 'vscode';
import type { ClientState } from '../../shared/protocol';
import type { RuntimePaths, StorageCapability } from './types';

const CHAT_HISTORY_FILE = 'chat-history.json';
const CHAT_HISTORY_VERSION = 1;

interface StoredClientStateFile {
  version: number;
  savedAt: string;
  globalStoragePath: string;
  state: ClientState;
}

export function createVsCodeStorageCapability(context: vscode.ExtensionContext): StorageCapability {
  const chatHistoryUri = vscode.Uri.joinPath(context.globalStorageUri, CHAT_HISTORY_FILE);
  const paths: RuntimePaths = {
    globalStorageUri: context.globalStorageUri,
    globalStoragePath: context.globalStorageUri.fsPath,
    chatHistoryUri,
    chatHistoryPath: chatHistoryUri.fsPath
  };

  return {
    paths,
    async ensureReady() {
      await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    },
    async loadClientState() {
      await vscode.workspace.fs.createDirectory(context.globalStorageUri);

      let raw: Uint8Array;
      try {
        raw = await vscode.workspace.fs.readFile(chatHistoryUri);
      } catch {
        return undefined;
      }

      const text = Buffer.from(raw).toString('utf8').trim();
      if (!text) return undefined;

      try {
        const parsed = JSON.parse(text) as Partial<StoredClientStateFile> | Partial<ClientState>;
        const candidate = isStoredClientStateFile(parsed) ? parsed.state : parsed;
        return normalizeClientState(candidate as Partial<ClientState>);
      } catch (error) {
        console.warn('[LimCode] Failed to parse chat history:', error);
        return undefined;
      }
    },
    async saveClientState(state) {
      await vscode.workspace.fs.createDirectory(context.globalStorageUri);
      const payload: StoredClientStateFile = {
        version: CHAT_HISTORY_VERSION,
        savedAt: new Date().toISOString(),
        globalStoragePath: context.globalStorageUri.fsPath,
        state: normalizeClientState(state)
      };
      await vscode.workspace.fs.writeFile(chatHistoryUri, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
    }
  };
}

function isStoredClientStateFile(value: unknown): value is StoredClientStateFile {
  return !!value && typeof value === 'object' && 'state' in value;
}

function normalizeClientState(value: Partial<ClientState> | undefined): ClientState {
  return {
    agents: Array.isArray(value?.agents) ? value.agents : [],
    sessions: Array.isArray(value?.sessions) ? value.sessions : [],
    messages: Array.isArray(value?.messages) ? value.messages : [],
    toolCalls: Array.isArray(value?.toolCalls) ? value.toolCalls : []
  };
}
