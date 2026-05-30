import * as vscode from 'vscode';
import type { ConversationSettingsRecord, MessageRecord, SessionRecord, ToolCallRecord } from '../../../shared/protocol';
import {
  CHUNKS_DIR,
  CONVERSATION_SETTINGS_DIR,
  CONVERSATION_SETTINGS_FILE,
  CONVERSATION_META_FILE,
  INDEX_FILE,
  MESSAGES_DIR,
  MESSAGES_PER_CHUNK,
  STORAGE_VERSION
} from './constants';
import { readJson, writeJson } from './json';
import { sortableName } from './naming';

interface ConversationsIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversations: ConversationIndexRecord[];
}

interface ConversationIndexRecord extends SessionRecord {
  folder: string;
  metaFile: string;
  messagesIndexFile: string;
  messageCount: number;
  chunkCount: number;
  latestSeq: number;
  updatedAt: string;
}

interface ConversationMetaFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  session: SessionRecord;
}

interface ConversationSettingsFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  settings: ConversationSettingsRecord;
}

interface MessageIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  sessionId: string;
  chunkSize: number;
  messageCount: number;
  chunks: MessageChunkRef[];
}

interface MessageChunkRef {
  id: string;
  file: string;
  startSeq: number;
  endSeq: number;
  count: number;
}

interface MessageChunkFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  sessionId: string;
  chunkId: string;
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
}

export interface ConversationsData {
  sessions: SessionRecord[];
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
}

export async function loadConversations(root: vscode.Uri, indexUri: vscode.Uri): Promise<ConversationsData | undefined> {
  const index = await readJson<ConversationsIndexFile>(indexUri);
  if (!index || index.schemaVersion !== STORAGE_VERSION) return undefined;

  const sessions: SessionRecord[] = [];
  const messages: MessageRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];

  for (const record of index.conversations) {
    const conversationDir = vscode.Uri.joinPath(root, record.folder);
    const meta = await readJson<ConversationMetaFile>(vscode.Uri.joinPath(root, ...record.metaFile.split('/')));
    if (meta?.schemaVersion !== STORAGE_VERSION) continue;
    const settings = await readConversationSettingsFile(conversationDir, meta.session.id);
    sessions.push({ ...meta.session, ...(settings ? { title: settings.name } : {}) });

    const messageIndex = await readJson<MessageIndexFile>(vscode.Uri.joinPath(root, ...record.messagesIndexFile.split('/')));
    if (!messageIndex || messageIndex.schemaVersion !== STORAGE_VERSION) continue;

    for (const chunkRef of messageIndex.chunks) {
      const chunk = await readJson<MessageChunkFile>(vscode.Uri.joinPath(conversationDir, MESSAGES_DIR, ...chunkRef.file.split('/')));
      if (!chunk || chunk.schemaVersion !== STORAGE_VERSION) continue;
      messages.push(...chunk.messages);
      toolCalls.push(...chunk.toolCalls);
    }
  }

  return { sessions, messages: sortMessages(messages), toolCalls };
}

export async function saveConversations(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  sessions: SessionRecord[],
  messages: MessageRecord[],
  toolCalls: ToolCallRecord[]
): Promise<void> {
  const savedAt = new Date().toISOString();
  const conversations: ConversationIndexRecord[] = [];
  const previousIndex = await readJson<ConversationsIndexFile>(indexUri);
  const previousById = new Map(previousIndex?.conversations.map((record) => [record.id, record]));

  for (const session of sessions) {
    const folder = previousById.get(session.id)?.folder ?? sortableName(session.id, session.title);
    const conversationDir = vscode.Uri.joinPath(root, folder);
    const messagesDir = vscode.Uri.joinPath(conversationDir, MESSAGES_DIR);
    const chunksDir = vscode.Uri.joinPath(messagesDir, CHUNKS_DIR);
    const settingsDir = vscode.Uri.joinPath(conversationDir, CONVERSATION_SETTINGS_DIR);
    await vscode.workspace.fs.createDirectory(chunksDir);
    await vscode.workspace.fs.createDirectory(settingsDir);

    const sessionMessages = sortMessages(messages.filter((message) => message.sessionId === session.id));
    const sessionToolCalls = toolCallsByMessageId(toolCalls, new Set(sessionMessages.map((message) => message.id)));
    const chunkRefs: MessageChunkRef[] = [];

    for (let offset = 0; offset < sessionMessages.length; offset += MESSAGES_PER_CHUNK) {
      const chunkMessages = sessionMessages.slice(offset, offset + MESSAGES_PER_CHUNK);
      const chunkIndex = Math.floor(offset / MESSAGES_PER_CHUNK);
      const chunkId = chunkIndex.toString().padStart(6, '0');
      const chunkToolCalls = toolCallsByMessageId(sessionToolCalls, new Set(chunkMessages.map((message) => message.id)));
      const chunkFile = `${CHUNKS_DIR}/${chunkId}.json`;
      const first = chunkMessages[0];
      const last = chunkMessages[chunkMessages.length - 1];

      await writeJson(vscode.Uri.joinPath(messagesDir, ...chunkFile.split('/')), {
        schemaVersion: STORAGE_VERSION,
        savedAt,
        sessionId: session.id,
        chunkId,
        messages: chunkMessages,
        toolCalls: chunkToolCalls
      } satisfies MessageChunkFile);

      chunkRefs.push({
        id: chunkId,
        file: chunkFile,
        startSeq: first?.seq ?? 0,
        endSeq: last?.seq ?? 0,
        count: chunkMessages.length
      });
    }

    const metaFile = `${folder}/${CONVERSATION_META_FILE}`;
    const messagesIndexFile = `${folder}/${MESSAGES_DIR}/${INDEX_FILE}`;
    await writeJson(vscode.Uri.joinPath(root, ...metaFile.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      session
    } satisfies ConversationMetaFile);
    await writeJson(vscode.Uri.joinPath(settingsDir, CONVERSATION_SETTINGS_FILE), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      settings: createConversationSettings(session)
    } satisfies ConversationSettingsFile);
    await writeJson(vscode.Uri.joinPath(root, ...messagesIndexFile.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      sessionId: session.id,
      chunkSize: MESSAGES_PER_CHUNK,
      messageCount: sessionMessages.length,
      chunks: chunkRefs
    } satisfies MessageIndexFile);

    conversations.push({
      id: session.id,
      title: session.title,
      folder,
      metaFile,
      messagesIndexFile,
      messageCount: sessionMessages.length,
      chunkCount: chunkRefs.length,
      latestSeq: sessionMessages[sessionMessages.length - 1]?.seq ?? 0,
      updatedAt: savedAt
    });
  }

  await writeJson(indexUri, {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    conversations
  } satisfies ConversationsIndexFile);
}

export async function loadConversationSettings(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  sessionId: string
): Promise<ConversationSettingsRecord | undefined> {
  const index = await readJson<ConversationsIndexFile>(indexUri);
  const record = index?.conversations.find((candidate) => candidate.id === sessionId);
  if (!record) return undefined;
  return readConversationSettingsFile(vscode.Uri.joinPath(root, record.folder), sessionId);
}

export async function saveConversationSettings(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  settings: ConversationSettingsRecord
): Promise<ConversationSettingsRecord> {
  const savedAt = new Date().toISOString();
  const index = await readJson<ConversationsIndexFile>(indexUri);
  const record = index?.conversations.find((candidate) => candidate.id === settings.sessionId);
  if (!record) return settings;
  const folder = record.folder;
  const conversationDir = vscode.Uri.joinPath(root, folder);
  const settingsDir = vscode.Uri.joinPath(conversationDir, CONVERSATION_SETTINGS_DIR);
  await vscode.workspace.fs.createDirectory(settingsDir);
  await writeJson(vscode.Uri.joinPath(settingsDir, CONVERSATION_SETTINGS_FILE), {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    settings
  } satisfies ConversationSettingsFile);
  return settings;
}

async function readConversationSettingsFile(conversationDir: vscode.Uri, sessionId: string): Promise<ConversationSettingsRecord | undefined> {
  const file = await readJson<ConversationSettingsFile>(
    vscode.Uri.joinPath(conversationDir, CONVERSATION_SETTINGS_DIR, CONVERSATION_SETTINGS_FILE)
  );
  if (!file || file.schemaVersion !== STORAGE_VERSION) return undefined;
  return { sessionId, name: file.settings.name || sessionId };
}

function createConversationSettings(session: SessionRecord): ConversationSettingsRecord {
  return {
    sessionId: session.id,
    name: session.title?.trim() || session.id
  };
}

function sortMessages(messages: MessageRecord[]): MessageRecord[] {
  return [...messages].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function toolCallsByMessageId(toolCalls: ToolCallRecord[], messageIds: Set<string>): ToolCallRecord[] {
  return toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
}
