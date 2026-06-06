import type { CLIENT_STATE_TABLES } from './clientStateSchema';

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

export function conversationSettingsStreamId(conversationId: string, section: ConversationSettingsSection = 'common'): string {
  return `${CONVERSATION_SETTINGS_STREAM_PREFIX}${conversationId}:${section}`;
}

export function conversationIdFromSettingsStreamId(streamId: string): string | undefined {
  if (!streamId.startsWith(CONVERSATION_SETTINGS_STREAM_PREFIX)) return undefined;
  const rest = streamId.slice(CONVERSATION_SETTINGS_STREAM_PREFIX.length);
  const separator = rest.lastIndexOf(':');
  return separator >= 0 ? rest.slice(0, separator) : rest;
}

export function conversationClientStateStreamId(conversationId: string): string {
  return `${CONVERSATION_CLIENT_STATE_STREAM_PREFIX}${conversationId}${CONVERSATION_CLIENT_STATE_STREAM_SUFFIX}`;
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
  MessageEdit = 'message.edit',
  MessageDeleteFrom = 'message.deleteFrom',
  MessageRetryFrom = 'message.retryFrom',
  AgentRunCancel = 'agentRun.cancel',
  AgentRunPause = 'agentRun.pause',
  AgentRunResume = 'agentRun.resume',
  AgentRunRetry = 'agentRun.retry',
  AgentRunRegenerate = 'agentRun.regenerate',
  AgentRunMarkStale = 'agentRun.markStale',
  ToolExecute = 'tool.execute',
  ClientResync = 'client.resync',
  ClientSnapshot = 'state.snapshot',
  ClientPatch = 'state.patch',
  RunHistoryPageGet = 'runHistory.page.get',
  RunHistoryPageSnapshot = 'runHistory.page.snapshot',
  RunHistoryDetailGet = 'runHistory.detail.get',
  RunHistoryDetailSnapshot = 'runHistory.detail.snapshot',
  LlmDryRunGet = 'llm.dryRun.get',
  LlmDryRunSnapshot = 'llm.dryRun.snapshot',
  GlobalSettingsGet = 'settings.global.get',
  GlobalSettingsUpdate = 'settings.global.update',
  GlobalSettingsSnapshot = 'settings.global.snapshot',
  ConversationSettingsGet = 'settings.conversation.get',
  ConversationSettingsUpdate = 'settings.conversation.update',
  ConversationSettingsSnapshot = 'settings.conversation.snapshot',
  ProjectFoldersGet = 'projectFolders.get',
  ProjectFoldersSnapshot = 'projectFolders.snapshot',
  ConversationProjectSet = 'conversation.project.set'
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

export interface SidebarConversationHistoryEntry {
  id: string;
  title: string;
  preview: string;
  previewState?: 'pending' | 'empty';
  messageCount: number;
  status: MsgStatus | 'empty';
  updatedAt?: number;
  agentName?: string;
  isRunning: boolean;
  runStatus?: AgentRunStatus;
  runStatusLabel?: string;
  projectFolderUri?: string;
  projectName?: string;
}

export interface OpenConversationPanelRecord {
  conversationId: string;
  visible: boolean;
  active: boolean;
}

export type ConversationHistoryScope =
  | { kind: 'project'; folderUri: string }
  | { kind: 'unbound' }
  | { kind: 'all' };

export type SidebarHistoryScopeKind = 'currentProject' | 'project' | 'unbound' | 'all';

export interface ConversationHistoryPageRequest {
  scope: ConversationHistoryScope;
  cursor?: string;
  limit?: number;
}

export interface ConversationHistoryPageInfo {
  cursor?: string;
  nextCursor?: string;
  previousCursor?: string;
  pageIndex: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface ConversationHistoryPageRecord {
  scope: ConversationHistoryScope;
  entries: SidebarConversationHistoryEntry[];
  pageInfo: ConversationHistoryPageInfo;
}

export type MsgRole = 'user' | 'model';
export type MsgStatus = 'streaming' | 'complete' | 'error';
export type MessageStopReason = 'paused' | 'cancelled' | 'replaced' | 'stale';

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

export interface LlmUsageMetadataRecord {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cacheCreationInputTokenCount?: number;
  cacheCreationInputTokensDetails?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LlmSettingsRecord {
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  proxy?: string;
  temperature?: number;
}

export interface AgentRecord {
  id: string;
  name: string;
  kind: string;
  status: 'idle' | 'thinking' | 'running' | 'done' | 'error';
}

export type ApprovalMode = 'never' | 'onRisk' | 'always' | 'manualOnly';
export type AgentRunKind = 'chat' | 'tool_invoked' | 'delegated' | 'review' | 'notification' | 'scheduled';
export type AgentRunStatus = 'queued' | 'preparing' | 'running' | 'waiting_tool' | 'waiting_child_run' | 'delivering' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'stale';
export type AgentRunEndReason = 'completed' | 'failed' | 'cancelled_by_user' | 'cancelled_by_policy' | 'stale_source_edited' | 'retry_requested' | 'regenerate_requested';
export type AgentRunErrorType = 'llm' | 'tool' | 'policy' | 'cancelled' | 'stale' | 'unknown';
export type AgentRunSourceKind = 'user' | 'toolCall' | 'agentRun' | 'schedule' | 'system';
export type AgentRunTargetRole = 'executor';
export type MessageRunRole = 'input' | 'model' | 'tool_response' | 'notification';
export type ToolCallRunRole = 'produced_by';
export type PolicyBindingRole = 'active';

export interface AgentModeRecord {
  id: string;
  name: string;
  description?: string;
}


export interface ToolPolicyRecord {
  id: string;
  name: string;
  allowedTools: string[];
}

export interface ApprovalPolicyRecord {
  id: string;
  name: string;
  mode: ApprovalMode;
  allowInteractiveApproval: boolean;
}

export interface SystemPromptRecord {
  id: string;
  name: string;
  text: string;
}

export interface ModelProfileRecord {
  id: string;
  name: string;
  provider: LlmProviderKind;
  model: string;
  temperature?: number;
}

export type AgentModeRole = 'active' | 'available' | 'default';
export type ModeBindingRole = 'active';

export interface AgentModeLinkRecord {
  id: string;
  agentId: string;
  modeId: string;
  role: AgentModeRole;
}

export interface ModeToolPolicyLinkRecord {
  id: string;
  modeId: string;
  toolPolicyId: string;
  role: ModeBindingRole;
}

export interface ModeApprovalPolicyLinkRecord {
  id: string;
  modeId: string;
  approvalPolicyId: string;
  role: ModeBindingRole;
}

export interface ModeSystemPromptLinkRecord {
  id: string;
  modeId: string;
  systemPromptId: string;
  role: ModeBindingRole;
}

export interface ModeModelProfileLinkRecord {
  id: string;
  modeId: string;
  modelProfileId: string;
  role: ModeBindingRole;
}

export interface ConversationRecord {
  id: string;
  title?: string;
  visibility?: 'visible' | 'hidden' | 'collapsed';
}

export interface ConversationReuseLinkRecord {
  id: string;
  key: string;
  conversationId: string;
  agentId?: string;
}

export type ConversationBranchKind = 'fork' | 'branch_from_revision';

export interface ConversationBranchLinkRecord {
  id: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceRevisionId?: string;
  kind: ConversationBranchKind;
}


export type AgentConversationRole = 'default' | 'participant' | 'reviewer';

export type ProjectContextKind = 'folder';

export interface ProjectContextRecord {
  id: string;
  kind: ProjectContextKind;
  uri: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export type ConversationProjectRole = 'primary';

export interface ConversationProjectLinkRecord {
  id: string;
  conversationId: string;
  projectContextId: string;
  role: ConversationProjectRole;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConversationLinkRecord {
  id: string;
  agentId: string;
  conversationId: string;
  role: AgentConversationRole;
}

export type ContentRole = MsgRole;

export interface TextPart {
  text: string;
  thought?: boolean;
  thoughtSignature?: string;
  thoughtDurationMs?: number;
}

export interface FunctionCallPart {
  id?: string;
  functionCall: {
    name: string;
    args: unknown;
  };
  thoughtSignature?: string;
}

export interface FunctionResponsePart {
  id?: string;
  functionResponse: {
    name: string;
    response: unknown;
  };
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
  conversationId: string;
  role: MsgRole;
  content: MessageContent;
  status: MsgStatus;
  createdAt: number;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  stopReason?: MessageStopReason;
  seq: number;
}

export type MessageRevisionReason = 'created' | 'edited' | 'regenerated' | 'system';

export interface MessageRevisionRecord {
  id: string;
  messageId: string;
  conversationId: string;
  content: MessageContent;
  createdAt: number;
  reason: MessageRevisionReason;
}

export interface MessageCurrentRevisionLinkRecord {
  id: string;
  messageId: string;
  revisionId: string;
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

export type ConversationPolicyMode = 'same_conversation' | 'new_conversation' | 'reuse_conversation' | 'fork_conversation' | 'branch_from_revision';
export type ConversationVisibility = 'visible' | 'hidden' | 'collapsed';
export type ContextHistoryMode = 'none' | 'full' | 'last_n' | 'since_message' | 'selected_messages' | 'summary';
export type DeliveryMode = 'direct_reply' | 'tool_response' | 'notification' | 'append_to_source_conversation' | 'silent';
export type TranscriptInclusion = 'none' | 'summary' | 'selected' | 'full' | 'link';
export type SourceEditBehavior = 'ignore_snapshot' | 'abort_and_restart' | 'append_correction' | 'branch_new_run' | 'mark_stale';
export type NewMessageWhileRunningBehavior = 'queue_next_run' | 'interrupt_current' | 'append_to_target' | 'ignore';

export interface RunConversationPolicyRecord {
  id: string;
  mode: ConversationPolicyMode;
  conversationId?: string;
  reuseKey?: string;
  branchFromConversationId?: string;
  branchFromRevisionId?: string;
  visibility: ConversationVisibility;
}

export interface RunContextPolicyRecord {
  id: string;
  historyMode: ContextHistoryMode;
  lastN?: number;
  sinceMessageId?: string;
  selectedMessageIds?: string[];
  includeSourceContext?: boolean;
  includeSourceToolResult?: boolean;
}

export interface RunDeliveryPolicyRecord {
  id: string;
  mode: DeliveryMode;
  includeTranscript: TranscriptInclusion;
  targetConversationId?: string;
  targetToolCallId?: string;
}

export interface RunEditPolicyRecord {
  id: string;
  onSourceEdited: SourceEditBehavior;
  onNewUserMessageWhileRunning: NewMessageWhileRunningBehavior;
}

export interface AgentRunRecord {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  endReason?: AgentRunEndReason;
  errorType?: AgentRunErrorType;
  error?: string;
  usageMetadata?: LlmUsageMetadataRecord;
  retryOfRunId?: string;
  attempt?: number;
}

export interface AgentRunSourceLinkRecord {
  id: string;
  runId: string;
  sourceKind: AgentRunSourceKind;
  sourceAgentId?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  sourceToolCallId?: string;
  sourceRunId?: string;
}

export interface AgentRunTargetLinkRecord {
  id: string;
  runId: string;
  agentId: string;
  conversationId: string;
  role: AgentRunTargetRole;
}

export interface MessageRunLinkRecord {
  id: string;
  messageId: string;
  runId: string;
  role: MessageRunRole;
}

export interface ToolCallRunLinkRecord {
  id: string;
  toolCallId: string;
  runId: string;
  role: ToolCallRunRole;
}

export interface RunModeLinkRecord {
  id: string;
  runId: string;
  modeId: string;
  role: PolicyBindingRole;
}

export interface RunSystemPromptLinkRecord {
  id: string;
  runId: string;
  systemPromptId: string;
  role: PolicyBindingRole;
}

export interface RunModelProfileLinkRecord {
  id: string;
  runId: string;
  modelProfileId: string;
  role: PolicyBindingRole;
}

export interface RunToolPolicyLinkRecord {
  id: string;
  runId: string;
  toolPolicyId: string;
  role: PolicyBindingRole;
}

export interface RunApprovalPolicyLinkRecord {
  id: string;
  runId: string;
  approvalPolicyId: string;
  role: PolicyBindingRole;
}

export interface RunConversationPolicyLinkRecord {
  id: string;
  runId: string;
  policyId: string;
  role: PolicyBindingRole;
}

export interface RunContextPolicyLinkRecord {
  id: string;
  runId: string;
  policyId: string;
  role: PolicyBindingRole;
}

export interface RunDeliveryPolicyLinkRecord {
  id: string;
  runId: string;
  policyId: string;
  role: PolicyBindingRole;
}

export interface RunEditPolicyLinkRecord {
  id: string;
  runId: string;
  policyId: string;
  role: PolicyBindingRole;
}

export interface AgentRunInputRevisionRecord {
  id: string;
  runId: string;
  conversationId: string;
  revisionId: string;
}

export interface ClientStateRecordByTable {
  agents: AgentRecord;
  agentModes: AgentModeRecord;
  toolPolicies: ToolPolicyRecord;
  approvalPolicies: ApprovalPolicyRecord;
  systemPrompts: SystemPromptRecord;
  modelProfiles: ModelProfileRecord;
  agentModeLinks: AgentModeLinkRecord;
  modeToolPolicyLinks: ModeToolPolicyLinkRecord;
  modeApprovalPolicyLinks: ModeApprovalPolicyLinkRecord;
  modeSystemPromptLinks: ModeSystemPromptLinkRecord;
  modeModelProfileLinks: ModeModelProfileLinkRecord;
  conversations: ConversationRecord;
  conversationReuseLinks: ConversationReuseLinkRecord;
  conversationBranchLinks: ConversationBranchLinkRecord;
  agentConversationLinks: AgentConversationLinkRecord;
  projectContexts: ProjectContextRecord;
  conversationProjectLinks: ConversationProjectLinkRecord;
  messages: MessageRecord;
  messageRevisions: MessageRevisionRecord;
  messageCurrentRevisionLinks: MessageCurrentRevisionLinkRecord;
  toolCalls: ToolCallRecord;
  toolCallEvents: ToolCallEventRecord;
  agentRuns: AgentRunRecord;
  agentRunSourceLinks: AgentRunSourceLinkRecord;
  agentRunTargetLinks: AgentRunTargetLinkRecord;
  messageRunLinks: MessageRunLinkRecord;
  toolCallRunLinks: ToolCallRunLinkRecord;
  runConversationPolicies: RunConversationPolicyRecord;
  runContextPolicies: RunContextPolicyRecord;
  runDeliveryPolicies: RunDeliveryPolicyRecord;
  runEditPolicies: RunEditPolicyRecord;
  runModeLinks: RunModeLinkRecord;
  runSystemPromptLinks: RunSystemPromptLinkRecord;
  runModelProfileLinks: RunModelProfileLinkRecord;
  runToolPolicyLinks: RunToolPolicyLinkRecord;
  runApprovalPolicyLinks: RunApprovalPolicyLinkRecord;
  runConversationPolicyLinks: RunConversationPolicyLinkRecord;
  runContextPolicyLinks: RunContextPolicyLinkRecord;
  runDeliveryPolicyLinks: RunDeliveryPolicyLinkRecord;
  runEditPolicyLinks: RunEditPolicyLinkRecord;
  agentRunInputRevisions: AgentRunInputRevisionRecord;
}

export type ClientStateTableKey = keyof ClientStateRecordByTable;
export type ClientStateTableRecord<TKey extends ClientStateTableKey> = ClientStateRecordByTable[TKey] & { id: string };
export type ClientState = {
  [TKey in ClientStateTableKey]: ClientStateTableRecord<TKey>[];
};

type ClientStateTableRegistrySpec = typeof CLIENT_STATE_TABLES;
type StringLiteral<T> = T extends string ? T : never;

type UpsertPatchForTable<TKey extends ClientStateTableKey> = ClientStateTableRegistrySpec[TKey] extends {
  readonly patch: { readonly upsert: { readonly kind: infer TKind; readonly payloadField: infer TField } };
} ? { kind: StringLiteral<TKind> } & { [TFieldKey in StringLiteral<TField>]: ClientStateTableRecord<TKey> } : never;

type AppendPatchForTable<TKey extends ClientStateTableKey> = ClientStateTableRegistrySpec[TKey] extends {
  readonly patch: { readonly append: { readonly kind: infer TKind; readonly payloadField: infer TField } };
} ? { kind: StringLiteral<TKind> } & { [TFieldKey in StringLiteral<TField>]: ClientStateTableRecord<TKey> } : never;

type RemovePatchForTable<TKey extends ClientStateTableKey> = ClientStateTableRegistrySpec[TKey] extends {
  readonly patch: { readonly remove: { readonly kind: infer TKind } };
} ? { kind: StringLiteral<TKind>; id: string } : never;

export type ClientStateTablePatchOp = {
  [TKey in ClientStateTableKey]: UpsertPatchForTable<TKey> | AppendPatchForTable<TKey> | RemovePatchForTable<TKey> | MutationPatchForTable<TKey>;
}[ClientStateTableKey];

type MutationPatchForSpec<TSpec> = TSpec extends {
  readonly kind: infer TKind;
  readonly __payload?: infer TPayload;
} ? { kind: StringLiteral<TKind> } & (TPayload extends object ? TPayload : never) : never;

type MutationPatchForTable<TKey extends ClientStateTableKey> = ClientStateTableRegistrySpec[TKey] extends {
  readonly clientSync: { readonly mutations: readonly (infer TMutationSpec)[] };
} ? MutationPatchForSpec<TMutationSpec> : never;

export type ClientPatchOp = ClientStateTablePatchOp;

export interface ChatSendPayload {
  conversationId: string;
  text: string;
}
export interface ChatAbortPayload {
  conversationId: string;
}
export interface MessageEditPayload {
  conversationId: string;
  messageId: string;
  text: string;
  runAfterEdit?: boolean;
  deleteFollowing?: boolean;
}
export interface MessageDeleteFromPayload {
  conversationId: string;
  messageId: string;
}
export interface MessageRetryFromPayload {
  conversationId: string;
  messageId: string;
}
export interface AgentRunControlPayload {
  runId: string;
  conversationId?: string;
  reason?: string;
}
export interface ToolExecutePayload {
  toolCallId: string;
  conversationId?: string;
}
export interface ClientResyncPayload {
  streamId?: string;
  conversationId?: string;
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

export interface ConversationRunHistoryPageRequest {
  conversationId: string;
  cursor?: string;
  limit?: number;
}

export interface ConversationRunSummaryRecord {
  id: string;
  conversationId: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  endReason?: AgentRunEndReason;
  errorType?: AgentRunErrorType;
  error?: string;
  retryOfRunId?: string;
  attempt?: number;
  sourceKind?: AgentRunSourceKind;
  sourceMessageId?: string;
  sourceToolCallId?: string;
  sourceRunId?: string;
  targetAgentId?: string;
  targetConversationId?: string;
  inputMessageCount: number;
  outputMessageCount: number;
  toolCallCount: number;
  inputPreview?: string;
  outputPreview?: string;
}

export interface ConversationRunHistoryPageInfo {
  cursor?: string;
  nextCursor?: string;
  previousCursor?: string;
  pageIndex: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface ConversationRunHistoryPageRecord {
  conversationId: string;
  runs: ConversationRunSummaryRecord[];
  pageInfo: ConversationRunHistoryPageInfo;
}

export interface ConversationRunDetailRequest {
  conversationId: string;
  runId: string;
}

export interface ConversationRunDetailRecord {
  conversationId: string;
  runId: string;
  summary?: ConversationRunSummaryRecord;
  state: ClientState;
}

export interface LlmDryRunGetPayload {
  conversationId: string;
  runId: string;
  /** true 时 curl 中显示 API Key；默认 false，避免泄漏密钥。 */
  includeApiKey?: boolean;
}

export interface LlmDryRunSnapshotPayload {
  conversationId: string;
  runId: string;
  provider?: LlmProviderKind;
  model?: string;
  providerName?: string;
  url: string;
  method: 'POST';
  stream: boolean;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
  curl: string;
  /** 始终隐藏敏感 header 的 curl，用于前端本地显示/隐藏切换，避免重复 dry-run。 */
  maskedCurl: string;
  inputFormat?: string;
  outputFormat?: string;
  generatedAt: number;
  maskedSecrets: boolean;
}


export interface GlobalSettingsRecord {
  dataFilePath: string;
  activeDataRootPath: string;
  defaultDataRootPath: string;
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
  conversationId: string;
  name: string;
}
export type ConversationSettingsSectionValue = ConversationSettingsRecord;
export interface ConversationSettingsGetPayload {
  conversationId: string;
  section: ConversationSettingsSection;
}
export interface ConversationSettingsSnapshotPayload {
  conversationId: string;
  section: ConversationSettingsSection;
  settings: ConversationSettingsSectionValue;
  filePath: string;
}
export interface ConversationSettingsUpdatePayload {
  section: ConversationSettingsSection;
  settings: ConversationSettingsSectionValue;
}

export interface ProjectFolderCandidateRecord {
  uri: string;
  name: string;
  index: number;
}

export interface ProjectFoldersSnapshotPayload {
  folders: ProjectFolderCandidateRecord[];
}

export interface ConversationProjectSetPayload {
  conversationId: string;
  folderUri: string;
  name?: string;
}

export type WebviewToExtensionMessage =
  | BridgeEnvelope<BridgeMessageType.Ready, undefined>
  | BridgeEnvelope<BridgeMessageType.Ack, BridgeAckPayload>
  | BridgeEnvelope<BridgeMessageType.Ping, { text: string; sentAt: number }>
  | BridgeEnvelope<BridgeMessageType.GetWorkspaceInfo, undefined>
  | BridgeEnvelope<BridgeMessageType.ShowInfo, { message: string }>
  | BridgeEnvelope<BridgeMessageType.ChatSend, ChatSendPayload>
  | BridgeEnvelope<BridgeMessageType.ChatAbort, ChatAbortPayload>
  | BridgeEnvelope<BridgeMessageType.MessageEdit, MessageEditPayload>
  | BridgeEnvelope<BridgeMessageType.MessageDeleteFrom, MessageDeleteFromPayload>
  | BridgeEnvelope<BridgeMessageType.MessageRetryFrom, MessageRetryFromPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunCancel, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunPause, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunResume, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunRetry, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunRegenerate, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunMarkStale, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.ToolExecute, ToolExecutePayload>
  | BridgeEnvelope<BridgeMessageType.ClientResync, ClientResyncPayload>
  | BridgeEnvelope<BridgeMessageType.RunHistoryPageGet, ConversationRunHistoryPageRequest>
  | BridgeEnvelope<BridgeMessageType.RunHistoryDetailGet, ConversationRunDetailRequest>
  | BridgeEnvelope<BridgeMessageType.LlmDryRunGet, LlmDryRunGetPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsGet, GlobalSettingsGetPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsUpdate, GlobalSettingsUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsGet, ConversationSettingsGetPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsUpdate, ConversationSettingsUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.ProjectFoldersGet, undefined>
  | BridgeEnvelope<BridgeMessageType.ConversationProjectSet, ConversationProjectSetPayload>;

export type ExtensionToWebviewMessage =
  | BridgeEnvelope<BridgeMessageType.Hello, BridgeHelloPayload>
  | BridgeEnvelope<BridgeMessageType.Pong, { text: string; receivedAt: number }>
  | BridgeEnvelope<BridgeMessageType.WorkspaceInfo, WorkspaceInfo>
  | BridgeEnvelope<BridgeMessageType.Error, { requestType?: string; message: string }>
  | BridgeEnvelope<BridgeMessageType.ClientSnapshot, ClientSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ClientPatch, ClientPatchPayload>
  | BridgeEnvelope<BridgeMessageType.RunHistoryPageSnapshot, ConversationRunHistoryPageRecord>
  | BridgeEnvelope<BridgeMessageType.RunHistoryDetailSnapshot, ConversationRunDetailRecord>
  | BridgeEnvelope<BridgeMessageType.LlmDryRunSnapshot, LlmDryRunSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsSnapshot, GlobalSettingsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsSnapshot, ConversationSettingsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ProjectFoldersSnapshot, ProjectFoldersSnapshotPayload>;

export function createMessageId(): MessageId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
