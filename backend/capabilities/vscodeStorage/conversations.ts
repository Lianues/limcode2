import * as vscode from 'vscode';
import type {
  ConversationSettingsRecord,
  ConversationSettingsSection,
  ConversationSettingsSectionValue,
  MessageRecord,
  SessionRecord,
  ToolCallEventRecord,
  ToolCallRecord,
  ToolCallStatus
} from '../../../shared/protocol';
import {
  CHUNKS_DIR,
  CONVERSATION_SETTINGS_DIR,
  CONVERSATION_SETTINGS_FILE,
  CONVERSATION_META_FILE,
  EVENTS_DIR,
  INDEX_FILE,
  MESSAGES_DIR,
  MESSAGES_PER_CHUNK,
  RECORDS_DIR,
  STORAGE_VERSION,
  TOOL_CALL_FILE,
  TOOL_CALLS_DIR
} from './constants';
import { readJson, writeJson } from './json';
import { sortableNameWithExactIdSuffix, sortableNameWithReadableSuffix } from './naming';

const TOOL_CALL_EVENTS_PER_CHUNK = 200;

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
  latestMessageId?: string;
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
  settings: ConversationSettingsSectionValue;
}

interface MessageIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  sessionId: string;
  chunkSize: number;
  messageCount: number;
  chunks: MessageChunkRef[];
  /** 只做定位索引：message id -> chunk。实际消息内容仍读取对应 chunk 文件。 */
  records: MessageIndexRecord[];
}

interface MessageIndexRecord {
  id: string;
  chunkId: string;
  file: string;
}

interface MessageChunkRef {
  id: string;
  file: string;
  startMessageId?: string;
  endMessageId?: string;
  count: number;
}

type StoredMessageRecord = {
  id: string;
  role: MessageRecord['content']['role'];
  parts: MessageRecord['content']['parts'];
  status: MessageRecord['status'];
  createdAt: number;
  streamOutputDurationMs?: number;
};

interface MessageChunkFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  sessionId: string;
  chunkId: string;
  messages: StoredMessageRecord[];
}

interface ToolCallsIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  sessionId: string;
  records: ToolCallIndexRecord[];
}

interface ToolCallIndexRecord {
  id: string;
  folder: string;
  file: string;
  messageId: string;
  functionCallId?: string;
  name: string;
  status: ToolCallStatus;
  createdAt: number;
  updatedAt: number;
  eventCount: number;
}

interface ToolCallRecordFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  toolCall: ToolCallRecord;
}

interface ToolCallEventsIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  toolCallId: string;
  eventCount: number;
  chunks: ToolCallEventChunkRef[];
}

interface ToolCallEventChunkRef {
  id: string;
  file: string;
  startSeq: number;
  endSeq: number;
  count: number;
}

interface ToolCallEventChunkFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  toolCallId: string;
  chunkId: string;
  events: ToolCallEventRecord[];
}

export interface ConversationsData {
  sessions: SessionRecord[];
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  toolCallEvents: ToolCallEventRecord[];
}

export async function loadConversations(root: vscode.Uri, indexUri: vscode.Uri): Promise<ConversationsData | undefined> {
  const index = await readJson<ConversationsIndexFile>(indexUri);
  if (!index || index.schemaVersion !== STORAGE_VERSION) return undefined;

  const sessions: SessionRecord[] = [];
  const messages: MessageRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const toolCallEvents: ToolCallEventRecord[] = [];
  let nextSeq = 1;

  for (const record of index.conversations) {
    const conversationDir = vscode.Uri.joinPath(root, record.folder);
    const meta = await readJson<ConversationMetaFile>(vscode.Uri.joinPath(root, ...record.metaFile.split('/')));
    if (meta?.schemaVersion !== STORAGE_VERSION) continue;
    const settings = await readConversationSettingsFile(conversationDir, meta.session.id, 'common');
    sessions.push({ ...meta.session, ...(settings ? { title: settings.name } : {}) });

    const messageIndex = await readJson<MessageIndexFile>(vscode.Uri.joinPath(root, ...record.messagesIndexFile.split('/')));
    if (messageIndex?.schemaVersion === STORAGE_VERSION) {
      for (const chunkRef of messageIndex.chunks) {
        const chunk = await readJson<MessageChunkFile>(vscode.Uri.joinPath(conversationDir, MESSAGES_DIR, ...chunkRef.file.split('/')));
        if (!chunk || chunk.schemaVersion !== STORAGE_VERSION) continue;
        for (const message of chunk.messages) messages.push(toRuntimeMessage(messageIndex.sessionId, message, nextSeq++));
      }
    }

    const loadedTools = await loadToolCallsForConversation(conversationDir, meta.session.id);
    toolCalls.push(...loadedTools.toolCalls);
    toolCallEvents.push(...loadedTools.toolCallEvents);
  }

  return { sessions, messages: sortMessages(messages), toolCalls, toolCallEvents: sortToolCallEvents(toolCallEvents) };
}

export async function saveConversations(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  sessions: SessionRecord[],
  messages: MessageRecord[],
  toolCalls: ToolCallRecord[],
  toolCallEvents: ToolCallEventRecord[] = []
): Promise<void> {
  const savedAt = new Date().toISOString();
  const conversations: ConversationIndexRecord[] = [];
  const previousIndex = await readJson<ConversationsIndexFile>(indexUri);
  const previousById = new Map(previousIndex?.conversations.map((record) => [record.id, record]));

  for (const session of sessions) {
    const folder = previousById.get(session.id)?.folder ?? sortableNameWithReadableSuffix(session.id, session.title);
    const conversationDir = vscode.Uri.joinPath(root, folder);
    const messagesDir = vscode.Uri.joinPath(conversationDir, MESSAGES_DIR);
    const messageChunksDir = vscode.Uri.joinPath(messagesDir, CHUNKS_DIR);
    const settingsDir = vscode.Uri.joinPath(conversationDir, CONVERSATION_SETTINGS_DIR);
    await vscode.workspace.fs.createDirectory(messageChunksDir);
    await vscode.workspace.fs.createDirectory(settingsDir);

    const sessionMessages = sortMessages(messages.filter((message) => message.sessionId === session.id));
    const messageIds = new Set(sessionMessages.map((message) => message.id));
    const sessionToolCalls = toolCallsByMessageId(toolCalls, messageIds);
    const toolCallIds = new Set(sessionToolCalls.map((toolCall) => toolCall.id));
    const sessionToolCallEvents = sortToolCallEvents(toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId)));
    const chunkRefs: MessageChunkRef[] = [];
    const messageRecords: MessageIndexRecord[] = [];

    for (let offset = 0; offset < sessionMessages.length; offset += MESSAGES_PER_CHUNK) {
      const chunkMessages = sessionMessages.slice(offset, offset + MESSAGES_PER_CHUNK);
      const chunkIndex = Math.floor(offset / MESSAGES_PER_CHUNK);
      const chunkId = chunkIndex.toString().padStart(6, '0');
      const chunkFile = `${CHUNKS_DIR}/${chunkId}.json`;
      const first = chunkMessages[0];
      const last = chunkMessages[chunkMessages.length - 1];

      await writeJson(vscode.Uri.joinPath(messagesDir, ...chunkFile.split('/')), {
        schemaVersion: STORAGE_VERSION,
        savedAt,
        sessionId: session.id,
        chunkId,
        messages: chunkMessages.map(toStoredMessage)
      } satisfies MessageChunkFile);

      for (const message of chunkMessages) {
        messageRecords.push({ id: message.id, chunkId, file: chunkFile });
      }

      chunkRefs.push({ id: chunkId, file: chunkFile, startMessageId: first?.id, endMessageId: last?.id, count: chunkMessages.length });
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
      settings: createDefaultConversationSettings('common', session)
    } satisfies ConversationSettingsFile);
    await writeJson(vscode.Uri.joinPath(root, ...messagesIndexFile.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      sessionId: session.id,
      chunkSize: MESSAGES_PER_CHUNK,
      messageCount: sessionMessages.length,
      chunks: chunkRefs,
      records: messageRecords
    } satisfies MessageIndexFile);

    await saveToolCallsForConversation(conversationDir, session.id, sessionToolCalls, sessionToolCallEvents, savedAt);

    conversations.push({
      id: session.id,


      title: session.title,
      folder,
      metaFile,
      messagesIndexFile,
      messageCount: sessionMessages.length,
      chunkCount: chunkRefs.length,
      latestMessageId: sessionMessages[sessionMessages.length - 1]?.id,
      updatedAt: savedAt
    });
  }

  await writeJson(indexUri, { schemaVersion: STORAGE_VERSION, savedAt, conversations } satisfies ConversationsIndexFile);
}

export async function saveMessageSnapshot(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  sessionId: string,
  message: MessageRecord
): Promise<void> {
  const { conversationDir } = await ensureConversationFolder(root, indexUri, { id: sessionId });
  const messagesDir = vscode.Uri.joinPath(conversationDir, MESSAGES_DIR);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(messagesDir, CHUNKS_DIR));

  const index = await readMessageIndex(messagesDir, sessionId);
  const existing = index.records.find((record) => record.id === message.id);

  if (existing) {
    const chunk = await readMessageChunk(messagesDir, existing.file, sessionId, existing.chunkId);
    const messages = upsertStoredMessage(chunk.messages, message).sort(compareStoredMessagesById(index));
    await writeMessageChunk(messagesDir, existing.file, sessionId, existing.chunkId, messages);
    await writeMessageIndex(messagesDir, rebuildMessageIndex(index, messagesByChunk(index, existing.chunkId, messages)));
    return;
  }

  const target = chooseAppendMessageChunk(index);
  const chunk = await readMessageChunk(messagesDir, target.file, sessionId, target.id);
  const messages = [...chunk.messages, toStoredMessage(message)];
  await writeMessageChunk(messagesDir, target.file, sessionId, target.id, messages);
  const nextIndex = addMessageToIndex(index, target, message.id, messages);
  await writeMessageIndex(messagesDir, nextIndex);
}

export async function removeMessage(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  sessionId: string,
  messageId: string
): Promise<void> {
  const index = await readJson<ConversationsIndexFile>(indexUri);
  const record = index?.conversations.find((candidate) => candidate.id === sessionId);
  if (!record) return;
  const conversationDir = vscode.Uri.joinPath(root, record.folder);
  const messagesDir = vscode.Uri.joinPath(conversationDir, MESSAGES_DIR);
  const messageIndex = await readMessageIndex(messagesDir, sessionId);
  const locator = messageIndex.records.find((candidate) => candidate.id === messageId);
  if (!locator) return;

  const chunk = await readMessageChunk(messagesDir, locator.file, sessionId, locator.chunkId);
  const nextMessages = chunk.messages.filter((message) => message.id !== messageId);
  await writeMessageChunk(messagesDir, locator.file, sessionId, locator.chunkId, nextMessages);
  await writeMessageIndex(messagesDir, removeMessageFromIndex(messageIndex, locator, nextMessages));
}


export async function saveToolCallSnapshot(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  sessionId: string,
  toolCall: ToolCallRecord
): Promise<void> {
  const { conversationDir } = await ensureConversationFolder(root, indexUri, { id: sessionId });
  const toolCallsDir = vscode.Uri.joinPath(conversationDir, TOOL_CALLS_DIR);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(toolCallsDir, RECORDS_DIR));
  const index = await readToolCallsIndex(toolCallsDir, sessionId);
  const existing = index.records.find((record) => record.id === toolCall.id);
  const folder = existing?.folder ?? `${RECORDS_DIR}/${sortableNameWithExactIdSuffix(toolCall.id)}`;
  const file = `${folder}/${TOOL_CALL_FILE}`;
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(toolCallsDir, ...folder.split('/')));
  await writeToolCallRecordFile(toolCallsDir, file, toolCall, new Date().toISOString());
  const eventCount = existing?.eventCount ?? await countPersistedToolCallEvents(toolCallsDir, folder, toolCall.id);
  await writeToolCallsIndex(toolCallsDir, sessionId, upsertToolCallIndexRecord(index.records, toolCall, folder, file, eventCount));
}

export async function appendToolCallEvent(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  sessionId: string,
  event: ToolCallEventRecord
): Promise<void> {
  const { conversationDir } = await ensureConversationFolder(root, indexUri, { id: sessionId });
  const toolCallsDir = vscode.Uri.joinPath(conversationDir, TOOL_CALLS_DIR);
  const index = await readToolCallsIndex(toolCallsDir, sessionId);
  const record = index.records.find((item) => item.id === event.toolCallId);
  if (!record) return;
  const eventCount = await appendToolCallEventToFolder(toolCallsDir, record.folder, event, new Date().toISOString());
  await writeToolCallsIndex(toolCallsDir, sessionId, index.records.map((item) => item.id === record.id ? { ...item, eventCount, updatedAt: Math.max(item.updatedAt, event.at), status: event.status ?? item.status } : item));
}

export async function loadConversationSettings(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  sessionId: string,
  section: ConversationSettingsSection
): Promise<{ sessionId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string } | undefined> {
  const index = await readJson<ConversationsIndexFile>(indexUri);
  const record = index?.conversations.find((candidate) => candidate.id === sessionId);
  if (!record) return undefined;
  const conversationDir = vscode.Uri.joinPath(root, record.folder);
  const settings = await readConversationSettingsFile(conversationDir, sessionId, section)
    ?? createDefaultConversationSettings(section, { id: sessionId, title: record.title });
  const fileUri = vscode.Uri.joinPath(conversationDir, CONVERSATION_SETTINGS_DIR, conversationSettingsFileName(section));
  return { sessionId, section, settings, filePath: fileUri.fsPath };
}

export async function saveConversationSettings(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  section: ConversationSettingsSection,
  settings: ConversationSettingsSectionValue
): Promise<{ sessionId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string }> {
  const savedAt = new Date().toISOString();
  const { conversationDir } = await ensureConversationFolder(root, indexUri, { id: settings.sessionId, title: settings.name });
  const settingsDir = vscode.Uri.joinPath(conversationDir, CONVERSATION_SETTINGS_DIR);
  await vscode.workspace.fs.createDirectory(settingsDir);
  const fileUri = vscode.Uri.joinPath(settingsDir, conversationSettingsFileName(section));
  const normalized = normalizeConversationSettings(section, settings);
  await writeJson(fileUri, { schemaVersion: STORAGE_VERSION, savedAt, settings: normalized } satisfies ConversationSettingsFile);
  return { sessionId: normalized.sessionId, section, settings: normalized, filePath: fileUri.fsPath };
}

async function ensureConversationFolder(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  session: SessionRecord
): Promise<{ record: ConversationIndexRecord; conversationDir: vscode.Uri }> {
  const savedAt = new Date().toISOString();
  const index = await readJson<ConversationsIndexFile>(indexUri) ?? { schemaVersion: STORAGE_VERSION, savedAt, conversations: [] };
  const existing = index.conversations.find((candidate) => candidate.id === session.id);
  if (existing) return { record: existing, conversationDir: vscode.Uri.joinPath(root, existing.folder) };

  const folder = sortableNameWithReadableSuffix(session.id, session.title);
  const record: ConversationIndexRecord = {
    id: session.id,
    title: session.title,
    folder,
    metaFile: `${folder}/${CONVERSATION_META_FILE}`,
    messagesIndexFile: `${folder}/${MESSAGES_DIR}/${INDEX_FILE}`,
    messageCount: 0,
    chunkCount: 0,
    updatedAt: savedAt
  };
  const conversationDir = vscode.Uri.joinPath(root, folder);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(conversationDir, MESSAGES_DIR, CHUNKS_DIR));
  await writeJson(vscode.Uri.joinPath(root, ...record.metaFile.split('/')), { schemaVersion: STORAGE_VERSION, savedAt, session } satisfies ConversationMetaFile);
  await writeJson(vscode.Uri.joinPath(root, ...record.messagesIndexFile.split('/')), { schemaVersion: STORAGE_VERSION, savedAt, sessionId: session.id, chunkSize: MESSAGES_PER_CHUNK, messageCount: 0, chunks: [], records: [] } satisfies MessageIndexFile);
  await writeJson(indexUri, { schemaVersion: STORAGE_VERSION, savedAt, conversations: [...index.conversations, record] } satisfies ConversationsIndexFile);
  return { record, conversationDir };
}

async function loadToolCallsForConversation(conversationDir: vscode.Uri, sessionId: string): Promise<{ toolCalls: ToolCallRecord[]; toolCallEvents: ToolCallEventRecord[] }> {
  const toolCallsDir = vscode.Uri.joinPath(conversationDir, TOOL_CALLS_DIR);
  const index = await readJson<ToolCallsIndexFile>(vscode.Uri.joinPath(toolCallsDir, INDEX_FILE));
  if (!index || index.schemaVersion !== STORAGE_VERSION) return { toolCalls: [], toolCallEvents: [] };
  const toolCalls: ToolCallRecord[] = [];
  const toolCallEvents: ToolCallEventRecord[] = [];
  for (const record of index.records) {
    const file = await readJson<ToolCallRecordFile>(vscode.Uri.joinPath(toolCallsDir, ...record.file.split('/')));
    if (file?.schemaVersion === STORAGE_VERSION) toolCalls.push(file.toolCall);
    toolCallEvents.push(...await loadToolCallEvents(toolCallsDir, record.folder, record.id));
  }
  void sessionId;
  return { toolCalls, toolCallEvents: sortToolCallEvents(toolCallEvents) };
}

async function saveToolCallsForConversation(
  conversationDir: vscode.Uri,
  sessionId: string,
  toolCalls: ToolCallRecord[],
  events: ToolCallEventRecord[],
  savedAt: string
): Promise<void> {
  const toolCallsDir = vscode.Uri.joinPath(conversationDir, TOOL_CALLS_DIR);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(toolCallsDir, RECORDS_DIR));
  const previous = await readToolCallsIndex(toolCallsDir, sessionId);
  const previousById = new Map(previous.records.map((record) => [record.id, record]));
  const records: ToolCallIndexRecord[] = [];
  const eventsByToolCall = groupEventsByToolCall(events);

  for (const toolCall of toolCalls) {
    const previousRecord = previousById.get(toolCall.id);
    const folder = previousRecord?.folder ?? `${RECORDS_DIR}/${sortableNameWithExactIdSuffix(toolCall.id)}`;
    const file = `${folder}/${TOOL_CALL_FILE}`;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(toolCallsDir, ...folder.split('/')));
    await writeToolCallRecordFile(toolCallsDir, file, toolCall, savedAt);
    const eventCount = await writeToolCallEvents(toolCallsDir, folder, toolCall.id, eventsByToolCall.get(toolCall.id) ?? [], savedAt);
    records.push(toToolCallIndexRecord(toolCall, folder, file, eventCount));
  }

  await writeToolCallsIndex(toolCallsDir, sessionId, records, savedAt);
}

async function readToolCallsIndex(toolCallsDir: vscode.Uri, sessionId: string): Promise<ToolCallsIndexFile> {
  const existing = await readJson<ToolCallsIndexFile>(vscode.Uri.joinPath(toolCallsDir, INDEX_FILE));
  if (existing?.schemaVersion === STORAGE_VERSION) return existing;
  return { schemaVersion: STORAGE_VERSION, savedAt: new Date().toISOString(), sessionId, records: [] };
}

async function writeToolCallsIndex(toolCallsDir: vscode.Uri, sessionId: string, records: ToolCallIndexRecord[], savedAt = new Date().toISOString()): Promise<void> {
  await vscode.workspace.fs.createDirectory(toolCallsDir);
  await writeJson(vscode.Uri.joinPath(toolCallsDir, INDEX_FILE), { schemaVersion: STORAGE_VERSION, savedAt, sessionId, records } satisfies ToolCallsIndexFile);
}

async function writeToolCallRecordFile(toolCallsDir: vscode.Uri, file: string, toolCall: ToolCallRecord, savedAt: string): Promise<void> {
  await writeJson(vscode.Uri.joinPath(toolCallsDir, ...file.split('/')), { schemaVersion: STORAGE_VERSION, savedAt, toolCall } satisfies ToolCallRecordFile);
}

function toToolCallIndexRecord(toolCall: ToolCallRecord, folder: string, file: string, eventCount: number): ToolCallIndexRecord {
  return {
    id: toolCall.id,
    folder,
    file,
    messageId: toolCall.messageId,
    functionCallId: toolCall.functionCallId,
    name: toolCall.name,
    status: toolCall.status,
    createdAt: toolCall.createdAt,
    updatedAt: toolCall.updatedAt,
    eventCount
  };
}

function upsertToolCallIndexRecord(records: ToolCallIndexRecord[], toolCall: ToolCallRecord, folder: string, file: string, eventCount: number): ToolCallIndexRecord[] {
  const next = toToolCallIndexRecord(toolCall, folder, file, eventCount);
  const index = records.findIndex((record) => record.id === toolCall.id);
  if (index < 0) return [...records, next];
  const copy = [...records];
  copy[index] = next;
  return copy;
}

async function loadToolCallEvents(toolCallsDir: vscode.Uri, folder: string, toolCallId: string): Promise<ToolCallEventRecord[]> {
  const eventsRoot = vscode.Uri.joinPath(toolCallsDir, ...folder.split('/'), EVENTS_DIR);
  const index = await readJson<ToolCallEventsIndexFile>(vscode.Uri.joinPath(eventsRoot, INDEX_FILE));
  if (!index || index.schemaVersion !== STORAGE_VERSION) return [];
  const events: ToolCallEventRecord[] = [];
  for (const chunkRef of index.chunks) {
    const chunk = await readJson<ToolCallEventChunkFile>(vscode.Uri.joinPath(eventsRoot, ...chunkRef.file.split('/')));
    if (chunk?.schemaVersion === STORAGE_VERSION && chunk.toolCallId === toolCallId) events.push(...chunk.events);
  }
  return sortToolCallEvents(events);
}

async function writeToolCallEvents(toolCallsDir: vscode.Uri, folder: string, toolCallId: string, events: ToolCallEventRecord[], savedAt: string): Promise<number> {
  const eventsRoot = vscode.Uri.joinPath(toolCallsDir, ...folder.split('/'), EVENTS_DIR);
  const chunksRoot = vscode.Uri.joinPath(eventsRoot, CHUNKS_DIR);
  await vscode.workspace.fs.createDirectory(chunksRoot);
  const chunks: ToolCallEventChunkRef[] = [];
  const sorted = sortToolCallEvents(events);
  for (let offset = 0; offset < sorted.length; offset += TOOL_CALL_EVENTS_PER_CHUNK) {
    const chunkEvents = sorted.slice(offset, offset + TOOL_CALL_EVENTS_PER_CHUNK);
    const chunkIndex = Math.floor(offset / TOOL_CALL_EVENTS_PER_CHUNK);
    const chunkId = chunkIndex.toString().padStart(6, '0');
    const file = `${CHUNKS_DIR}/${chunkId}.json`;
    await writeJson(vscode.Uri.joinPath(eventsRoot, ...file.split('/')), { schemaVersion: STORAGE_VERSION, savedAt, toolCallId, chunkId, events: chunkEvents } satisfies ToolCallEventChunkFile);
    chunks.push({ id: chunkId, file, startSeq: chunkEvents[0]?.seq ?? 0, endSeq: chunkEvents[chunkEvents.length - 1]?.seq ?? 0, count: chunkEvents.length });
  }
  await writeJson(vscode.Uri.joinPath(eventsRoot, INDEX_FILE), { schemaVersion: STORAGE_VERSION, savedAt, toolCallId, eventCount: sorted.length, chunks } satisfies ToolCallEventsIndexFile);
  return sorted.length;
}

async function appendToolCallEventToFolder(toolCallsDir: vscode.Uri, folder: string, event: ToolCallEventRecord, savedAt: string): Promise<number> {
  const eventsRoot = vscode.Uri.joinPath(toolCallsDir, ...folder.split('/'), EVENTS_DIR);
  const chunksRoot = vscode.Uri.joinPath(eventsRoot, CHUNKS_DIR);
  await vscode.workspace.fs.createDirectory(chunksRoot);

  const indexUri = vscode.Uri.joinPath(eventsRoot, INDEX_FILE);
  const previous = await readJson<ToolCallEventsIndexFile>(indexUri);
  const index: ToolCallEventsIndexFile = previous?.schemaVersion === STORAGE_VERSION && previous.toolCallId === event.toolCallId
    ? previous
    : { schemaVersion: STORAGE_VERSION, savedAt, toolCallId: event.toolCallId, eventCount: 0, chunks: [] };
  const chunks = [...index.chunks];
  const last = chunks[chunks.length - 1];

  if (last && event.seq <= last.endSeq) {
    const existingEvents = await loadToolCallEvents(toolCallsDir, folder, event.toolCallId);
    if (existingEvents.some((candidate) => candidate.id === event.id)) return existingEvents.length;
    return writeToolCallEvents(toolCallsDir, folder, event.toolCallId, [...existingEvents, event], savedAt);
  }

  if (!last || last.count >= TOOL_CALL_EVENTS_PER_CHUNK) {
    const chunkId = chunks.length.toString().padStart(6, '0');
    const file = `${CHUNKS_DIR}/${chunkId}.json`;
    await writeToolCallEventChunk(eventsRoot, file, event.toolCallId, chunkId, [event], savedAt);
    chunks.push({ id: chunkId, file, startSeq: event.seq, endSeq: event.seq, count: 1 });
  } else {
    const chunk = await readJson<ToolCallEventChunkFile>(vscode.Uri.joinPath(eventsRoot, ...last.file.split('/')));
    const existingEvents = chunk?.schemaVersion === STORAGE_VERSION && chunk.toolCallId === event.toolCallId
      ? chunk.events
      : [];
    if (existingEvents.some((candidate) => candidate.id === event.id)) return index.eventCount;

    const events = sortToolCallEvents([...existingEvents, event]);
    await writeToolCallEventChunk(eventsRoot, last.file, event.toolCallId, last.id, events, savedAt);
    chunks[chunks.length - 1] = {
      ...last,
      startSeq: events[0]?.seq ?? event.seq,
      endSeq: events[events.length - 1]?.seq ?? event.seq,
      count: events.length
    };
  }

  const eventCount = chunks.reduce((count, chunk) => count + chunk.count, 0);
  await writeJson(indexUri, { schemaVersion: STORAGE_VERSION, savedAt, toolCallId: event.toolCallId, eventCount, chunks } satisfies ToolCallEventsIndexFile);
  return eventCount;
}

async function writeToolCallEventChunk(eventsRoot: vscode.Uri, file: string, toolCallId: string, chunkId: string, events: ToolCallEventRecord[], savedAt: string): Promise<void> {
  await writeJson(vscode.Uri.joinPath(eventsRoot, ...file.split('/')), {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    toolCallId,
    chunkId,
    events
  } satisfies ToolCallEventChunkFile);
}

async function countPersistedToolCallEvents(toolCallsDir: vscode.Uri, folder: string, toolCallId: string): Promise<number> {
  const index = await readJson<ToolCallEventsIndexFile>(vscode.Uri.joinPath(toolCallsDir, ...folder.split('/'), EVENTS_DIR, INDEX_FILE));
  return index?.schemaVersion === STORAGE_VERSION && index.toolCallId === toolCallId ? index.eventCount : 0;
}

function groupEventsByToolCall(events: ToolCallEventRecord[]): Map<string, ToolCallEventRecord[]> {
  const grouped = new Map<string, ToolCallEventRecord[]>();
  for (const event of events) {
    const bucket = grouped.get(event.toolCallId) ?? [];
    bucket.push(event);
    grouped.set(event.toolCallId, bucket);
  }
  return grouped;
}


async function readMessageIndex(messagesDir: vscode.Uri, sessionId: string): Promise<MessageIndexFile> {
  const index = await readJson<MessageIndexFile>(vscode.Uri.joinPath(messagesDir, INDEX_FILE));
  if (index?.schemaVersion === STORAGE_VERSION) return index;
  return { schemaVersion: STORAGE_VERSION, savedAt: new Date().toISOString(), sessionId, chunkSize: MESSAGES_PER_CHUNK, messageCount: 0, chunks: [], records: [] };
}

async function writeMessageIndex(messagesDir: vscode.Uri, index: MessageIndexFile): Promise<void> {
  await vscode.workspace.fs.createDirectory(messagesDir);
  await writeJson(vscode.Uri.joinPath(messagesDir, INDEX_FILE), { ...index, savedAt: new Date().toISOString() } satisfies MessageIndexFile);
}

async function readMessageChunk(messagesDir: vscode.Uri, file: string, sessionId: string, chunkId: string): Promise<MessageChunkFile> {
  const chunk = await readJson<MessageChunkFile>(vscode.Uri.joinPath(messagesDir, ...file.split('/')));
  if (chunk?.schemaVersion === STORAGE_VERSION) return chunk;
  return { schemaVersion: STORAGE_VERSION, savedAt: new Date().toISOString(), sessionId, chunkId, messages: [] };
}

async function writeMessageChunk(messagesDir: vscode.Uri, file: string, sessionId: string, chunkId: string, messages: StoredMessageRecord[]): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(messagesDir, CHUNKS_DIR));
  await writeJson(vscode.Uri.joinPath(messagesDir, ...file.split('/')), { schemaVersion: STORAGE_VERSION, savedAt: new Date().toISOString(), sessionId, chunkId, messages } satisfies MessageChunkFile);
}

function chooseAppendMessageChunk(index: MessageIndexFile): MessageChunkRef {
  const last = index.chunks[index.chunks.length - 1];
  if (last && last.count < index.chunkSize) return last;
  const chunkId = index.chunks.length.toString().padStart(6, '0');
  return { id: chunkId, file: `${CHUNKS_DIR}/${chunkId}.json`, count: 0 };
}

function upsertStoredMessage(messages: StoredMessageRecord[], message: MessageRecord): StoredMessageRecord[] {
  const stored = toStoredMessage(message);
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return [...messages, stored];
  const copy = [...messages];
  copy[index] = stored;
  return copy;
}

function compareStoredMessagesById(index: MessageIndexFile): (a: StoredMessageRecord, b: StoredMessageRecord) => number {
  const order = new Map(index.records.map((record, position) => [record.id, position]));
  return (a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id);
}

function messagesByChunk(index: MessageIndexFile, chunkId: string, messages: StoredMessageRecord[]): Map<string, StoredMessageRecord[]> {
  const grouped = new Map<string, StoredMessageRecord[]>();
  for (const chunk of index.chunks) grouped.set(chunk.id, []);
  grouped.set(chunkId, messages);
  return grouped;
}

function rebuildMessageIndex(index: MessageIndexFile, chunkMessages: Map<string, StoredMessageRecord[]>): MessageIndexFile {
  const chunks = index.chunks.map((chunk) => {
    const messages = chunkMessages.get(chunk.id);
    if (!messages) return chunk;
    return {
      ...chunk,
      startMessageId: messages[0]?.id,
      endMessageId: messages[messages.length - 1]?.id,
      count: messages.length
    };
  });
  const records = index.records.map((record) => chunkMessages.has(record.chunkId) && !chunkMessages.get(record.chunkId)!.some((message) => message.id === record.id)
    ? undefined
    : record
  ).filter((record): record is MessageIndexRecord => !!record);
  return { ...index, messageCount: records.length, chunks, records };
}

function addMessageToIndex(index: MessageIndexFile, chunk: MessageChunkRef, messageId: string, messages: StoredMessageRecord[]): MessageIndexFile {
  const chunkRef: MessageChunkRef = {
    ...chunk,
    startMessageId: messages[0]?.id,
    endMessageId: messages[messages.length - 1]?.id,
    count: messages.length
  };
  const chunks = index.chunks.some((candidate) => candidate.id === chunk.id)
    ? index.chunks.map((candidate) => candidate.id === chunk.id ? chunkRef : candidate)
    : [...index.chunks, chunkRef];
  const records = [...index.records.filter((record) => record.id !== messageId), { id: messageId, chunkId: chunk.id, file: chunk.file }];
  return { ...index, chunks, records, messageCount: records.length };
}

function removeMessageFromIndex(index: MessageIndexFile, locator: MessageIndexRecord, messages: StoredMessageRecord[]): MessageIndexFile {
  const chunks = index.chunks.map((chunk) => chunk.id === locator.chunkId
    ? { ...chunk, startMessageId: messages[0]?.id, endMessageId: messages[messages.length - 1]?.id, count: messages.length }
    : chunk
  );
  const records = index.records.filter((record) => record.id !== locator.id);
  return { ...index, chunks, records, messageCount: records.length };
}

async function readConversationSettingsFile(conversationDir: vscode.Uri, sessionId: string, section: ConversationSettingsSection): Promise<ConversationSettingsRecord | undefined> {
  const file = await readJson<ConversationSettingsFile>(vscode.Uri.joinPath(conversationDir, CONVERSATION_SETTINGS_DIR, conversationSettingsFileName(section)));
  if (!file || file.schemaVersion !== STORAGE_VERSION) return undefined;
  return normalizeConversationSettings(section, { ...file.settings, sessionId });
}

function createDefaultConversationSettings(section: ConversationSettingsSection, session: SessionRecord): ConversationSettingsRecord {
  void section;
  return { sessionId: session.id, name: session.title?.trim() || session.id };
}

function normalizeConversationSettings(section: ConversationSettingsSection, input: ConversationSettingsSectionValue): ConversationSettingsRecord {
  void section;
  const name = input.name.trim() || input.sessionId;
  return { sessionId: input.sessionId, name };
}

function conversationSettingsFileName(section: ConversationSettingsSection): string {
  void section;
  return CONVERSATION_SETTINGS_FILE;
}

function toStoredMessage(message: MessageRecord): StoredMessageRecord {
  return {
    id: message.id,
    role: message.content.role,
    parts: message.content.parts,
    status: message.status,
    createdAt: message.createdAt,
    streamOutputDurationMs: message.streamOutputDurationMs
  };
}

function toRuntimeMessage(sessionId: string, message: StoredMessageRecord, seq: number): MessageRecord {
  return {
    id: message.id,
    sessionId,
    role: message.role,
    content: { role: message.role, parts: message.parts },
    status: message.status,
    createdAt: message.createdAt,
    streamOutputDurationMs: message.streamOutputDurationMs,
    seq
  };
}

function sortMessages(messages: MessageRecord[]): MessageRecord[] {
  return [...messages].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function sortToolCallEvents(events: ToolCallEventRecord[]): ToolCallEventRecord[] {
  return [...events].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function toolCallsByMessageId(toolCalls: ToolCallRecord[], messageIds: Set<string>): ToolCallRecord[] {
  return toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
}
