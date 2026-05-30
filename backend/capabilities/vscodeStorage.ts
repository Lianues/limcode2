import * as vscode from 'vscode';
import type {
  AgentConversationLinkRecord,
  AgentRecord,
  ClientState,
  MessageRecord,
  SessionRecord,
  ToolCallRecord
} from '../../shared/protocol';
import type { RuntimePaths, StorageCapability } from './types';

const CHAT_ROOT_DIR = 'chat';
const CHAT_MANIFEST_FILE = 'manifest.json';
const SESSIONS_DIR = 'sessions';
const SESSION_INDEX_FILE = 'index.json';
const CHUNKS_DIR = 'chunks';
const CHAT_STORAGE_VERSION = 1;
const MESSAGES_PER_CHUNK = 100;

interface ChatManifestFile {
  schemaVersion: typeof CHAT_STORAGE_VERSION;
  savedAt: string;
  globalStoragePath: string;
  agents: AgentRecord[];
  sessions: ChatManifestSession[];
  agentConversationLinks: AgentConversationLinkRecord[];
}

interface ChatManifestSession extends SessionRecord {
  indexFile: string;
  messageCount: number;
  chunkCount: number;
  latestSeq: number;
  updatedAt: string;
}

interface SessionIndexFile {
  schemaVersion: typeof CHAT_STORAGE_VERSION;
  savedAt: string;
  sessionId: string;
  chunkSize: number;
  messageCount: number;
  chunks: ChatChunkRef[];
}

interface ChatChunkRef {
  id: string;
  file: string;
  startSeq: number;
  endSeq: number;
  count: number;
}

interface ChatChunkFile {
  schemaVersion: typeof CHAT_STORAGE_VERSION;
  savedAt: string;
  sessionId: string;
  chunkId: string;
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
}

export function createVsCodeStorageCapability(context: vscode.ExtensionContext): StorageCapability {
  const chatRootUri = vscode.Uri.joinPath(context.globalStorageUri, CHAT_ROOT_DIR);
  const chatManifestUri = vscode.Uri.joinPath(chatRootUri, CHAT_MANIFEST_FILE);
  const paths: RuntimePaths = {
    globalStorageUri: context.globalStorageUri,
    globalStoragePath: context.globalStorageUri.fsPath,
    chatRootUri,
    chatRootPath: chatRootUri.fsPath,
    chatManifestUri,
    chatManifestPath: chatManifestUri.fsPath
  };

  return {
    paths,
    async ensureReady() {
      await vscode.workspace.fs.createDirectory(chatRootUri);
    },
    async loadClientState() {
      await vscode.workspace.fs.createDirectory(chatRootUri);

      const manifest = await readJson<ChatManifestFile>(chatManifestUri);
      if (!manifest || manifest.schemaVersion !== CHAT_STORAGE_VERSION) return undefined;

      const messages: MessageRecord[] = [];
      const toolCalls: ToolCallRecord[] = [];
      const sessions: SessionRecord[] = manifest.sessions.map((session) => ({
        id: session.id,
        title: session.title
      }));

      for (const session of manifest.sessions) {
        const sessionDirUri = sessionDir(chatRootUri, session.id);
        const index = await readJson<SessionIndexFile>(vscode.Uri.joinPath(sessionDirUri, SESSION_INDEX_FILE));
        if (!index || index.schemaVersion !== CHAT_STORAGE_VERSION) continue;

        for (const chunkRef of index.chunks) {
          const chunk = await readJson<ChatChunkFile>(vscode.Uri.joinPath(sessionDirUri, ...chunkRef.file.split('/')));
          if (!chunk || chunk.schemaVersion !== CHAT_STORAGE_VERSION) continue;
          messages.push(...chunk.messages);
          toolCalls.push(...chunk.toolCalls);
        }
      }

      return {
        agents: manifest.agents,
        sessions,
        agentConversationLinks: manifest.agentConversationLinks,
        messages: sortMessages(messages),
        toolCalls
      };
    },
    async saveClientState(state) {
      await vscode.workspace.fs.createDirectory(chatRootUri);
      const savedAt = new Date().toISOString();
      const manifestSessions: ChatManifestSession[] = [];

      for (const session of state.sessions) {
        const sessionDirUri = sessionDir(chatRootUri, session.id);
        const chunksDirUri = vscode.Uri.joinPath(sessionDirUri, CHUNKS_DIR);
        await vscode.workspace.fs.createDirectory(chunksDirUri);

        const sessionMessages = sortMessages(state.messages.filter((message) => message.sessionId === session.id));
        const sessionToolCalls = toolCallsByMessageId(state.toolCalls, new Set(sessionMessages.map((message) => message.id)));
        const chunkRefs: ChatChunkRef[] = [];

        for (let offset = 0; offset < sessionMessages.length; offset += MESSAGES_PER_CHUNK) {
          const chunkMessages = sessionMessages.slice(offset, offset + MESSAGES_PER_CHUNK);
          const chunkIndex = Math.floor(offset / MESSAGES_PER_CHUNK);
          const chunkId = chunkIndex.toString().padStart(6, '0');
          const chunkToolCalls = toolCallsByMessageId(sessionToolCalls, new Set(chunkMessages.map((message) => message.id)));
          const chunkFile = `${CHUNKS_DIR}/${chunkId}.json`;
          const first = chunkMessages[0];
          const last = chunkMessages[chunkMessages.length - 1];
          const chunkRef: ChatChunkRef = {
            id: chunkId,
            file: chunkFile,
            startSeq: first?.seq ?? 0,
            endSeq: last?.seq ?? 0,
            count: chunkMessages.length
          };
          const chunk: ChatChunkFile = {
            schemaVersion: CHAT_STORAGE_VERSION,
            savedAt,
            sessionId: session.id,
            chunkId,
            messages: chunkMessages,
            toolCalls: chunkToolCalls
          };

          await writeJson(vscode.Uri.joinPath(sessionDirUri, ...chunkFile.split('/')), chunk);
          chunkRefs.push(chunkRef);
        }

        const index: SessionIndexFile = {
          schemaVersion: CHAT_STORAGE_VERSION,
          savedAt,
          sessionId: session.id,
          chunkSize: MESSAGES_PER_CHUNK,
          messageCount: sessionMessages.length,
          chunks: chunkRefs
        };
        await writeJson(vscode.Uri.joinPath(sessionDirUri, SESSION_INDEX_FILE), index);

        manifestSessions.push({
          id: session.id,
          title: session.title,
          indexFile: `${SESSIONS_DIR}/${sessionDirName(session.id)}/${SESSION_INDEX_FILE}`,
          messageCount: sessionMessages.length,
          chunkCount: chunkRefs.length,
          latestSeq: sessionMessages[sessionMessages.length - 1]?.seq ?? 0,
          updatedAt: savedAt
        });
      }

      const manifest: ChatManifestFile = {
        schemaVersion: CHAT_STORAGE_VERSION,
        savedAt,
        globalStoragePath: context.globalStorageUri.fsPath,
        agents: state.agents,
        sessions: manifestSessions,
        agentConversationLinks: state.agentConversationLinks
      };
      await writeJson(chatManifestUri, manifest);
    }
  };
}

function sessionDir(root: vscode.Uri, sessionId: string): vscode.Uri {
  return vscode.Uri.joinPath(root, SESSIONS_DIR, sessionDirName(sessionId));
}

function sessionDirName(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url') || 'empty';
}

function sortMessages(messages: MessageRecord[]): MessageRecord[] {
  return [...messages].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function toolCallsByMessageId(toolCalls: ToolCallRecord[], messageIds: Set<string>): ToolCallRecord[] {
  return toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
}

async function readJson<T>(uri: vscode.Uri): Promise<T | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(raw).toString('utf8').trim();
    return text ? JSON.parse(text) as T : undefined;
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    console.warn(`[LimCode] Failed to read JSON file: ${uri.fsPath}`, error);
    return undefined;
  }
}

async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function isFileNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /FileNotFound|ENOENT|not found/i.test(error.message);
}
