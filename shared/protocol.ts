export type MessageId = string;
export type BridgeClientId = string;

export type BridgeChannel = 'control' | 'command' | 'state' | 'settings' | 'diagnostics';

export type BridgeScope =
  | { kind: 'global' }
  | { kind: 'conversation'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'settings'; level: 'global' | 'conversation' | 'agent'; id?: string };

export interface WebviewClientMeta {
  kind: 'mainPanel' | 'globalSettings' | 'sidebar' | 'unknown';
  panelId?: string;
  title?: string;
  conversationId?: string;
}

export const GLOBAL_CLIENT_STATE_STREAM_ID = 'global:state';
export const GLOBAL_SETTINGS_STREAM_PREFIX = 'settings:global:';
export const GLOBAL_SETTINGS_SECTIONS = ['common', 'llm'] as const;
export type GlobalSettingsSection = typeof GLOBAL_SETTINGS_SECTIONS[number];

export function globalSettingsStreamId(section: GlobalSettingsSection): string {
  return `${GLOBAL_SETTINGS_STREAM_PREFIX}${section}`;
}

export const CONVERSATION_SETTINGS_STREAM_PREFIX = 'settings:conversation:';
export const CONVERSATION_SETTINGS_SECTIONS = ['common'] as const;
export type ConversationSettingsSection = typeof CONVERSATION_SETTINGS_SECTIONS[number];
export const CONVERSATION_CLIENT_STATE_STREAM_PREFIX = 'conversation:';
export const CONVERSATION_CLIENT_STATE_STREAM_SUFFIX = ':state';

export function conversationSettingsStreamId(sessionId: string, section: ConversationSettingsSection = 'common'): string {
  return `${CONVERSATION_SETTINGS_STREAM_PREFIX}${sessionId}:${section}`;
}

export function conversationIdFromSettingsStreamId(streamId: string): string | undefined {
  if (!streamId.startsWith(CONVERSATION_SETTINGS_STREAM_PREFIX)) return undefined;
  const rest = streamId.slice(CONVERSATION_SETTINGS_STREAM_PREFIX.length);
  const separator = rest.lastIndexOf(':');
  return separator >= 0 ? rest.slice(0, separator) : rest;
}

export function conversationClientStateStreamId(sessionId: string): string {
  return `${CONVERSATION_CLIENT_STATE_STREAM_PREFIX}${sessionId}${CONVERSATION_CLIENT_STATE_STREAM_SUFFIX}`;
}

export function conversationIdFromClientStateStreamId(streamId: string): string | undefined {
  return streamId.startsWith(CONVERSATION_CLIENT_STATE_STREAM_PREFIX) && streamId.endsWith(CONVERSATION_CLIENT_STATE_STREAM_SUFFIX)
    ? streamId.slice(CONVERSATION_CLIENT_STATE_STREAM_PREFIX.length, -CONVERSATION_CLIENT_STATE_STREAM_SUFFIX.length)
    : undefined;
}

export enum BridgeMessageType {
  Hello = 'bridge.hello',
  Ready = 'bridge.ready',
  Ping = 'bridge.ping',
  Pong = 'bridge.pong',
  Ack = 'bridge.ack',
  GetWorkspaceInfo = 'workspace.getInfo',
  WorkspaceInfo = 'workspace.info',
  ShowInfo = 'vscode.showInfo',
  Error = 'bridge.error',
  ChatSend = 'chat.send',
  ChatAbort = 'chat.abort',
  ClientResync = 'client.resync',
  ClientSnapshot = 'state.snapshot',
  ClientPatch = 'state.patch',
  GlobalSettingsGet = 'settings.global.get',
  GlobalSettingsUpdate = 'settings.global.update',
  GlobalSettingsSnapshot = 'settings.global.snapshot',
  ConversationSettingsGet = 'settings.conversation.get',
  ConversationSettingsUpdate = 'settings.conversation.update',
  ConversationSettingsSnapshot = 'settings.conversation.snapshot'
}

export interface BridgeEnvelope<TType extends string = string, TPayload = unknown> {
  id: MessageId;
  type: TType;
  channel: BridgeChannel;
  scope?: BridgeScope;
  clientId?: BridgeClientId;
  correlationId?: MessageId;
  seq?: number;
  ack?: number;
  payload?: TPayload;
}

export interface BridgeHelloPayload {
  clientId: BridgeClientId;
  attachedAt: number;
  meta: WebviewClientMeta;
}

export interface BridgeAckPayload {
  streamId?: string;
  seq?: number;
}

export interface WorkspaceInfo {
  name: string;
  folders: string[];
}

export type MsgRole = 'user' | 'model';
export type MsgStatus = 'streaming' | 'complete' | 'error';

export const TOOL_CALL_STATUSES = [
  'streaming',
  'queued',
  'awaiting_approval',
  'executing',
  'awaiting_apply',
  'success',
  'warning',
  'error'
] as const;
export type ToolCallStatus = typeof TOOL_CALL_STATUSES[number];
export const TERMINAL_TOOL_CALL_STATUSES: ReadonlySet<ToolCallStatus> = new Set(['success', 'warning', 'error']);

export type LlmProviderKind = 'deepseek' | 'openai-compatible' | 'openai-responses' | 'claude' | 'gemini';

export interface LlmSettingsRecord {
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature?: number;
}

export interface AgentRecord {
  id: string;
  name: string;
  kind: string;
  status: 'idle' | 'thinking' | 'running' | 'done' | 'error';
  parentAgentId?: string;
  model?: { provider: string; model: string; temperature?: number };
  toolPolicy?: { allowedTools: string[]; approvalMode: 'never' | 'onRisk' | 'always' };
  systemPrompt?: string;
}

export interface SessionRecord {
  id: string;
  title?: string;
}

export type AgentConversationRole = 'active' | 'participant' | 'reviewer';

export interface AgentConversationLinkRecord {
  id: string;
  agentId: string;
  sessionId: string;
  role: AgentConversationRole;
}

export type ContentRole = MsgRole;

export interface TextPart {
  text: string;
  /** Gemini thinking 文本块。它是模型思考内容，不应作为普通正文展示/保存为可见输出。 */
  thought?: boolean;
  /** 便于直接存取的单字符串签名形式。 */
  thoughtSignature?: string;
  /** 不同 provider 的思考签名。 */
  thoughtSignatures?: Record<string, string | undefined>;
  thoughtDurationMs?: number;
}

export interface FunctionCallPart {
  /** 应用侧工具调用 id，作为 Gemini-like part 的同层级元数据保留。 */
  id?: string;
  functionCall: {
    name: string;
    args: unknown;
  };
  /** Gemini thought signature 需要与 functionCall 同层级保存。 */
  thoughtSignature?: string;
}

export interface FunctionResponsePart {
  /** 应用侧工具调用 id，作为 Gemini-like part 的同层级元数据保留。 */
  id?: string;
  functionResponse: {
    name: string;
    response: unknown;
  };
  /** 非 Gemini 标准字段，但需要保持原有层级，便于 UI/诊断使用。 */
  durationMs?: number;
}

export interface InlineDataPart {
  inlineData: { mimeType: string; data: string };
}

export interface FileDataPart {
  fileData: { mimeType?: string; uri: string };
}

export type ContentPart = TextPart | FunctionCallPart | FunctionResponsePart | InlineDataPart | FileDataPart;

export function isTextPart(part: ContentPart): part is TextPart { return 'text' in part; }
export function isVisibleTextPart(part: ContentPart): part is TextPart { return isTextPart(part) && part.thought !== true; }
export function isFunctionCallPart(part: ContentPart): part is FunctionCallPart { return 'functionCall' in part; }
export function isFunctionResponsePart(part: ContentPart): part is FunctionResponsePart { return 'functionResponse' in part; }
export function isInlineDataPart(part: ContentPart): part is InlineDataPart { return 'inlineData' in part; }
export function isFileDataPart(part: ContentPart): part is FileDataPart { return 'fileData' in part; }

export interface MessageContent {
  role: ContentRole;
  parts: ContentPart[];
}

export function textContent(role: ContentRole, text: string): MessageContent {
  return { role, parts: text ? [{ text }] : [] };
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: MsgRole;
  content: MessageContent;
  status: MsgStatus;
  createdAt: number;
  streamOutputDurationMs?: number;
  seq: number;
}

export interface ToolCallRecord {
  id: string;
  messageId: string;
  name: string;
  functionCallId?: string;
  args: string;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  progress?: unknown;
  durationMs?: number;
  createdAt: number;
  updatedAt: number;
}

export type ToolCallEventKind =
  | 'created'
  | 'queued'
  | 'started'
  | 'progress'
  | 'stdout'
  | 'stderr'
  | 'state'
  | 'completed'
  | 'failed';

export interface ToolCallEventRecord {
  id: string;
  toolCallId: string;
  seq: number;
  kind: ToolCallEventKind;
  at: number;
  status?: ToolCallStatus;
  elapsedMs?: number;
  durationMs?: number;
  delta?: string;
  payload?: unknown;
  error?: string;
}

export interface ClientState {
  agents: AgentRecord[];
  sessions: SessionRecord[];
  agentConversationLinks: AgentConversationLinkRecord[];
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  toolCallEvents: ToolCallEventRecord[];
}

export type ClientPatchOp =
  | { kind: 'agent.upsert'; agent: AgentRecord }
  | { kind: 'agent.remove'; id: string }
  | { kind: 'session.upsert'; session: SessionRecord }
  | { kind: 'session.remove'; id: string }
  | { kind: 'agentConversationLink.upsert'; link: AgentConversationLinkRecord }
  | { kind: 'agentConversationLink.remove'; id: string }
  | { kind: 'message.upsert'; message: MessageRecord }
  | { kind: 'message.remove'; id: string }
  | { kind: 'message.appendText'; id: string; delta: string }
  | { kind: 'message.status'; id: string; status: MsgStatus }
  | { kind: 'toolcall.upsert'; toolCall: ToolCallRecord }
  | { kind: 'toolcall.remove'; id: string }
  | { kind: 'toolcallEvent.append'; event: ToolCallEventRecord }
  | { kind: 'toolcallEvent.remove'; id: string };

export interface ChatSendPayload {
  sessionId: string;
  text: string;
}
export interface ChatAbortPayload {
  sessionId: string;
}
export interface ClientResyncPayload {
  streamId?: string;
  sessionId?: string;
}
export interface ClientSnapshotPayload {
  streamId: string;
  streamSeq: number;
  state: ClientState;
}
export interface ClientPatchPayload {
  streamId: string;
  streamSeq: number;
  patches: ClientPatchOp[];
}
export interface GlobalSettingsRecord {
  dataFilePath: string;
}
export type GlobalSettingsSectionValue = GlobalSettingsRecord | LlmSettingsRecord;
export interface GlobalSettingsGetPayload {
  section: GlobalSettingsSection;
}
export interface GlobalSettingsSnapshotPayload {
  section: GlobalSettingsSection;
  settings: GlobalSettingsSectionValue;
  filePath: string;
}
export interface GlobalSettingsUpdatePayload {
  section: GlobalSettingsSection;
  settings: GlobalSettingsSectionValue;
}
export interface ConversationSettingsRecord {
  sessionId: string;
  name: string;
}
export type ConversationSettingsSectionValue = ConversationSettingsRecord;
export interface ConversationSettingsGetPayload {
  sessionId: string;
  section: ConversationSettingsSection;
}
export interface ConversationSettingsSnapshotPayload {
  sessionId: string;
  section: ConversationSettingsSection;
  settings: ConversationSettingsSectionValue;
  filePath: string;
}
export interface ConversationSettingsUpdatePayload {
  section: ConversationSettingsSection;
  settings: ConversationSettingsSectionValue;
}

export type WebviewToExtensionMessage =
  | BridgeEnvelope<BridgeMessageType.Ready, undefined>
  | BridgeEnvelope<BridgeMessageType.Ack, BridgeAckPayload>
  | BridgeEnvelope<BridgeMessageType.Ping, { text: string; sentAt: number }>
  | BridgeEnvelope<BridgeMessageType.GetWorkspaceInfo, undefined>
  | BridgeEnvelope<BridgeMessageType.ShowInfo, { message: string }>
  | BridgeEnvelope<BridgeMessageType.ChatSend, ChatSendPayload>
  | BridgeEnvelope<BridgeMessageType.ChatAbort, ChatAbortPayload>
  | BridgeEnvelope<BridgeMessageType.ClientResync, ClientResyncPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsGet, GlobalSettingsGetPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsUpdate, GlobalSettingsUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsGet, ConversationSettingsGetPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsUpdate, ConversationSettingsUpdatePayload>;

export type ExtensionToWebviewMessage =
  | BridgeEnvelope<BridgeMessageType.Hello, BridgeHelloPayload>
  | BridgeEnvelope<BridgeMessageType.Pong, { text: string; receivedAt: number }>
  | BridgeEnvelope<BridgeMessageType.WorkspaceInfo, WorkspaceInfo>
  | BridgeEnvelope<BridgeMessageType.Error, { requestType?: string; message: string }>
  | BridgeEnvelope<BridgeMessageType.ClientSnapshot, ClientSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ClientPatch, ClientPatchPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsSnapshot, GlobalSettingsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsSnapshot, ConversationSettingsSnapshotPayload>;

export function createMessageId(): MessageId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
