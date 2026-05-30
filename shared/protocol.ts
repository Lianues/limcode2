export type MessageId = string;

export enum BridgeMessageType {
  Ready = 'bridge:ready',
  Ping = 'bridge:ping',
  Pong = 'bridge:pong',
  GetWorkspaceInfo = 'workspace:getInfo',
  WorkspaceInfo = 'workspace:info',
  ShowInfo = 'vscode:showInfo',
  Error = 'bridge:error',
  ChatSend = 'chat:send',
  ChatAbort = 'chat:abort',
  ClientResync = 'client:resync',
  ClientSnapshot = 'client:snapshot',
  ClientPatch = 'client:patch',
  LlmSettingsGet = 'settings:llm:get',
  LlmSettingsUpdate = 'settings:llm:update',
  LlmSettingsSnapshot = 'settings:llm:snapshot'
}

export interface BridgeEnvelope<TType extends string = string, TPayload = unknown> {
  id?: MessageId;
  type: TType;
  payload?: TPayload;
}

export interface WorkspaceInfo {
  name: string;
  folders: string[];
}

export type MsgRole = 'user' | 'assistant' | 'tool';
export type MsgStatus = 'streaming' | 'complete' | 'error';
export type ToolCallStatus = 'pending' | 'running' | 'done' | 'failed';

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

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: MsgRole;
  text: string;
  status: MsgStatus;
  seq: number;
}

export interface ToolCallRecord {
  id: string;
  messageId: string;
  name: string;
  args: string;
  status: ToolCallStatus;
  result?: string;
}

export interface ClientState {
  agents: AgentRecord[];
  sessions: SessionRecord[];
  agentConversationLinks: AgentConversationLinkRecord[];
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
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
  | { kind: 'toolcall.remove'; id: string };

export interface ChatSendPayload {
  sessionId: string;
  text: string;
}
export interface ChatAbortPayload {
  sessionId: string;
}
export interface ClientResyncPayload {
  sessionId?: string;
}
export interface ClientSnapshotPayload {
  version: number;
  state: ClientState;
}
export interface ClientPatchPayload {
  version: number;
  patches: ClientPatchOp[];
}
export interface LlmSettingsSnapshotPayload {
  settings: LlmSettingsRecord;
  filePath: string;
}
export interface LlmSettingsUpdatePayload {
  settings: LlmSettingsRecord;
}

export type WebviewToExtensionMessage =
  | BridgeEnvelope<BridgeMessageType.Ready, undefined>
  | BridgeEnvelope<BridgeMessageType.Ping, { text: string; sentAt: number }>
  | BridgeEnvelope<BridgeMessageType.GetWorkspaceInfo, undefined>
  | BridgeEnvelope<BridgeMessageType.ShowInfo, { message: string }>
  | BridgeEnvelope<BridgeMessageType.ChatSend, ChatSendPayload>
  | BridgeEnvelope<BridgeMessageType.ChatAbort, ChatAbortPayload>
  | BridgeEnvelope<BridgeMessageType.ClientResync, ClientResyncPayload>
  | BridgeEnvelope<BridgeMessageType.LlmSettingsGet, undefined>
  | BridgeEnvelope<BridgeMessageType.LlmSettingsUpdate, LlmSettingsUpdatePayload>;

export type ExtensionToWebviewMessage =
  | BridgeEnvelope<BridgeMessageType.Pong, { text: string; receivedAt: number }>
  | BridgeEnvelope<BridgeMessageType.WorkspaceInfo, WorkspaceInfo>
  | BridgeEnvelope<BridgeMessageType.Error, { requestType?: string; message: string }>
  | BridgeEnvelope<BridgeMessageType.ClientSnapshot, ClientSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ClientPatch, ClientPatchPayload>
  | BridgeEnvelope<BridgeMessageType.LlmSettingsSnapshot, LlmSettingsSnapshotPayload>;

export function createMessageId(): MessageId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
