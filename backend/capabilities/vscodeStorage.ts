import * as vscode from 'vscode';
import type {
  AgentConversationLinkRecord,
  AgentRecord,
  ClientState,
  MessageRecord,
  SessionRecord,
  ToolCallRecord
} from '../../shared/protocol';
import type { LlmProviderKind, LlmSettingsRecord } from '../../shared/protocol';
import type { RuntimePaths, StorageCapability } from './types';
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from './llmProvider';

const STORAGE_VERSION = 1;
const INDEX_FILE = 'index.json';
const RECORDS_DIR = 'records';
const AGENTS_ROOT_DIR = 'agents';
const CONVERSATIONS_ROOT_DIR = 'conversations';
const LINKS_ROOT_DIR = 'agent-conversation-links';
const SETTINGS_ROOT_DIR = 'settings';
const LLM_SETTINGS_FILE = 'llm-api.json';
const CONVERSATION_META_FILE = 'conversation.json';
const MESSAGES_DIR = 'messages';
const CHUNKS_DIR = 'chunks';
const MESSAGES_PER_CHUNK = 100;

interface AgentsIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  records: AgentIndexRecord[];
}

interface AgentIndexRecord {
  id: string;
  file: string;
  updatedAt: string;
}

interface AgentRecordFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  agent: AgentRecord;
}

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

interface LinksIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  records: LinkIndexRecord[];
}

interface LinkIndexRecord {
  id: string;
  file: string;
  agentId: string;
  sessionId: string;
  role: AgentConversationLinkRecord['role'];
  updatedAt: string;
}

interface LinkRecordFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  link: AgentConversationLinkRecord;
}

interface LlmSettingsFile extends LlmSettingsRecord {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
}

export function createVsCodeStorageCapability(context: vscode.ExtensionContext): StorageCapability {
  const agentsRootUri = vscode.Uri.joinPath(context.globalStorageUri, AGENTS_ROOT_DIR);
  const agentsIndexUri = vscode.Uri.joinPath(agentsRootUri, INDEX_FILE);
  const conversationsRootUri = vscode.Uri.joinPath(context.globalStorageUri, CONVERSATIONS_ROOT_DIR);
  const conversationsIndexUri = vscode.Uri.joinPath(conversationsRootUri, INDEX_FILE);
  const linksRootUri = vscode.Uri.joinPath(context.globalStorageUri, LINKS_ROOT_DIR);
  const linksIndexUri = vscode.Uri.joinPath(linksRootUri, INDEX_FILE);
  const settingsRootUri = vscode.Uri.joinPath(context.globalStorageUri, SETTINGS_ROOT_DIR);
  const llmSettingsUri = vscode.Uri.joinPath(settingsRootUri, LLM_SETTINGS_FILE);

  const paths: RuntimePaths = {
    globalStorageUri: context.globalStorageUri,
    globalStoragePath: context.globalStorageUri.fsPath,
    agentsRootUri,
    agentsRootPath: agentsRootUri.fsPath,
    agentsIndexUri,
    agentsIndexPath: agentsIndexUri.fsPath,
    conversationsRootUri,
    conversationsRootPath: conversationsRootUri.fsPath,
    conversationsIndexUri,
    conversationsIndexPath: conversationsIndexUri.fsPath,
    linksRootUri,
    linksRootPath: linksRootUri.fsPath,
    linksIndexUri,
    linksIndexPath: linksIndexUri.fsPath,
    settingsRootUri,
    settingsRootPath: settingsRootUri.fsPath,
    llmSettingsUri,
    llmSettingsPath: llmSettingsUri.fsPath
  };

  return {
    paths,
    async ensureReady() {
      await ensureStorageRoots(agentsRootUri, conversationsRootUri, linksRootUri, settingsRootUri);
      await ensureLlmSettingsFile(llmSettingsUri);
    },
    async loadClientState() {
      await ensureStorageRoots(agentsRootUri, conversationsRootUri, linksRootUri);

      const [agents, sessionsAndMessages, agentConversationLinks] = await Promise.all([
        loadAgents(agentsRootUri, agentsIndexUri),
        loadConversations(conversationsRootUri, conversationsIndexUri),
        loadLinks(linksRootUri, linksIndexUri)
      ]);

      if (!agents && !sessionsAndMessages && !agentConversationLinks) return undefined;

      return {
        agents: agents ?? [],
        sessions: sessionsAndMessages?.sessions ?? [],
        agentConversationLinks: agentConversationLinks ?? [],
        messages: sessionsAndMessages?.messages ?? [],
        toolCalls: sessionsAndMessages?.toolCalls ?? []
      };
    },
    async saveClientState(state) {
      await ensureStorageRoots(agentsRootUri, conversationsRootUri, linksRootUri);
      await Promise.all([
        saveAgents(agentsRootUri, agentsIndexUri, state.agents),
        saveConversations(conversationsRootUri, conversationsIndexUri, state.sessions, state.messages, state.toolCalls),
        saveLinks(linksRootUri, linksIndexUri, state.agentConversationLinks)
      ]);
    },
    async loadLlmSettings() {
      await vscode.workspace.fs.createDirectory(settingsRootUri);
      return loadLlmSettingsFile(llmSettingsUri);
    },
    async saveLlmSettings(settings) {
      await vscode.workspace.fs.createDirectory(settingsRootUri);
      const normalized = normalizeLlmSettings(settings);
      await writeLlmSettingsFile(llmSettingsUri, normalized);
      return normalized;
    }
  };
}

async function ensureStorageRoots(...roots: vscode.Uri[]): Promise<void> {
  await Promise.all(roots.map((root) => vscode.workspace.fs.createDirectory(root)));
}

async function loadAgents(root: vscode.Uri, indexUri: vscode.Uri): Promise<AgentRecord[] | undefined> {
  const index = await readJson<AgentsIndexFile>(indexUri);
  if (!index || index.schemaVersion !== STORAGE_VERSION) return undefined;

  const agents: AgentRecord[] = [];
  for (const record of index.records) {
    const file = await readJson<AgentRecordFile>(vscode.Uri.joinPath(root, ...record.file.split('/')));
    if (file?.schemaVersion === STORAGE_VERSION) agents.push(file.agent);
  }
  return agents;
}

async function saveAgents(root: vscode.Uri, indexUri: vscode.Uri, agents: AgentRecord[]): Promise<void> {
  const savedAt = new Date().toISOString();
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  await vscode.workspace.fs.createDirectory(recordsRoot);
  const previousIndex = await readJson<AgentsIndexFile>(indexUri);
  const previousById = new Map(previousIndex?.records.map((record) => [record.id, record]));

  const records: AgentIndexRecord[] = [];
  for (const agent of agents) {
    const file = previousById.get(agent.id)?.file ?? `${RECORDS_DIR}/${sortableName(agent.id)}.json`;
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      agent
    } satisfies AgentRecordFile);
    records.push({ id: agent.id, file, updatedAt: savedAt });
  }

  await writeJson(indexUri, {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    records
  } satisfies AgentsIndexFile);
}

async function loadConversations(
  root: vscode.Uri,
  indexUri: vscode.Uri
): Promise<{ sessions: SessionRecord[]; messages: MessageRecord[]; toolCalls: ToolCallRecord[] } | undefined> {
  const index = await readJson<ConversationsIndexFile>(indexUri);
  if (!index || index.schemaVersion !== STORAGE_VERSION) return undefined;

  const sessions: SessionRecord[] = [];
  const messages: MessageRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];

  for (const record of index.conversations) {
    const conversationDir = vscode.Uri.joinPath(root, record.folder);
    const meta = await readJson<ConversationMetaFile>(vscode.Uri.joinPath(root, ...record.metaFile.split('/')));
    if (meta?.schemaVersion !== STORAGE_VERSION) continue;
    sessions.push(meta.session);

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

async function saveConversations(
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
    await vscode.workspace.fs.createDirectory(chunksDir);

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

async function loadLinks(root: vscode.Uri, indexUri: vscode.Uri): Promise<AgentConversationLinkRecord[] | undefined> {
  const index = await readJson<LinksIndexFile>(indexUri);
  if (!index || index.schemaVersion !== STORAGE_VERSION) return undefined;

  const links: AgentConversationLinkRecord[] = [];
  for (const record of index.records) {
    const file = await readJson<LinkRecordFile>(vscode.Uri.joinPath(root, ...record.file.split('/')));
    if (file?.schemaVersion === STORAGE_VERSION) links.push(file.link);
  }
  return links;
}

async function saveLinks(root: vscode.Uri, indexUri: vscode.Uri, links: AgentConversationLinkRecord[]): Promise<void> {
  const savedAt = new Date().toISOString();
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  await vscode.workspace.fs.createDirectory(recordsRoot);
  const previousIndex = await readJson<LinksIndexFile>(indexUri);
  const previousById = new Map(previousIndex?.records.map((record) => [record.id, record]));

  const records: LinkIndexRecord[] = [];
  for (const link of links) {
    const file = previousById.get(link.id)?.file ?? `${RECORDS_DIR}/${sortableName(link.id, `${link.role}-${link.agentId}-${link.sessionId}`)}.json`;
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      link
    } satisfies LinkRecordFile);
    records.push({
      id: link.id,
      file,
      agentId: link.agentId,
      sessionId: link.sessionId,
      role: link.role,
      updatedAt: savedAt
    });
  }

  await writeJson(indexUri, {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    records
  } satisfies LinksIndexFile);
}


async function ensureLlmSettingsFile(uri: vscode.Uri): Promise<void> {
  const settings = await readJson<LlmSettingsFile>(uri);
  if (settings?.schemaVersion === STORAGE_VERSION) return;
  await writeLlmSettingsFile(uri, createDefaultLlmSettings());
}

async function loadLlmSettingsFile(uri: vscode.Uri): Promise<LlmSettingsRecord> {
  const file = await readJson<LlmSettingsFile>(uri);
  if (!file || file.schemaVersion !== STORAGE_VERSION) {
    const defaults = createDefaultLlmSettings();
    await writeLlmSettingsFile(uri, defaults);
    return defaults;
  }

  const settings = normalizeLlmSettings(file);
  if (!sameLlmSettings(settings, file)) {
    await writeLlmSettingsFile(uri, settings);
  }
  return settings;
}

async function writeLlmSettingsFile(uri: vscode.Uri, settings: LlmSettingsRecord): Promise<void> {
  await writeJson(uri, {
    schemaVersion: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    ...settings
  } satisfies LlmSettingsFile);
}

function createDefaultLlmSettings(): LlmSettingsRecord {
  return {
    provider: 'deepseek',
    baseUrl: DEFAULT_LLM_BASE_URL,
    model: DEFAULT_LLM_MODEL,
    apiKey: '',
    temperature: 0.2
  };
}

function normalizeLlmSettings(input: Partial<LlmSettingsRecord> | undefined): LlmSettingsRecord {
  const defaults = createDefaultLlmSettings();
  const temperature = Number(input?.temperature ?? defaults.temperature);
  return {
    provider: isKnownProvider(input?.provider) ? input.provider : defaults.provider,
    baseUrl: stringOrDefault(input?.baseUrl, defaults.baseUrl),
    model: stringOrDefault(input?.model, defaults.model),
    apiKey: typeof input?.apiKey === 'string' ? input.apiKey.trim() : defaults.apiKey,
    temperature: Number.isFinite(temperature) ? temperature : defaults.temperature
  };
}

function sameLlmSettings(a: LlmSettingsRecord, b: Partial<LlmSettingsRecord>): boolean {
  return a.provider === b.provider &&
    a.baseUrl === b.baseUrl &&
    a.model === b.model &&
    a.apiKey === b.apiKey &&
    a.temperature === b.temperature;
}

function isKnownProvider(provider: unknown): provider is LlmProviderKind {
  return provider === 'deepseek' || provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'claude' || provider === 'gemini';
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function sortableName(id: string, label = id): string {
  return `${timestampForFileName()}-${slugify(label)}-${shortHash(id)}`;
}

function timestampForFileName(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '').replace('.', '-');
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'item';
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
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
