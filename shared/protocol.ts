import type { CLIENT_STATE_TABLES } from './clientStateSchema';

export type MessageId = string;
export type BridgeClientId = string;

export type BridgeChannel = 'control' | 'command' | 'state' | 'settings' | 'diagnostics';

export type BridgeScope =
  | { kind: 'global' }
  | { kind: 'conversation'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'settings'; level: 'global' | 'conversation' | 'agent' | 'mode'; id?: string };

export interface WebviewClientMeta {
  kind: 'mainPanel' | 'globalSettings' | 'modeSettings' | 'agentSettings' | 'sidebar' | 'unknown';
  panelId?: string;
  title?: string;
  conversationId?: string;
}

export const GLOBAL_CLIENT_STATE_STREAM_ID = 'global:state';
export const GLOBAL_SETTINGS_STREAM_PREFIX = 'settings:global:';
export const GLOBAL_SETTINGS_SECTIONS = ['common', 'llm', 'llmProviderConfigs'] as const;
export type GlobalSettingsSection = typeof GLOBAL_SETTINGS_SECTIONS[number];

export function globalSettingsStreamId(section: GlobalSettingsSection): string {
  return `${GLOBAL_SETTINGS_STREAM_PREFIX}${section}`;
}

export const CONVERSATION_SETTINGS_STREAM_PREFIX = 'settings:conversation:';
export const CONVERSATION_SETTINGS_SECTIONS = ['common', 'llm'] as const;
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
  ConversationOpen = 'conversation.open',
  AgentCreate = 'agent.create',
  AgentUpdate = 'agent.update',
  AgentDelete = 'agent.delete',
  SystemPromptScopeSet = 'systemPrompt.scope.set',
  SystemPromptScopeClear = 'systemPrompt.scope.clear',
  ModelProfileScopeSet = 'modelProfile.scope.set',
  ModelProfileScopeClear = 'modelProfile.scope.clear',
  MessageEdit = 'message.edit',
  MessageDeleteFrom = 'message.deleteFrom',
  MessageRetryFrom = 'message.retryFrom',
  AgentRunCancel = 'agentRun.cancel',
  AgentRunPause = 'agentRun.pause',
  AgentRunResume = 'agentRun.resume',
  AgentRunRetry = 'agentRun.retry',
  AgentRunRegenerate = 'agentRun.regenerate',
  AgentRunMarkStale = 'agentRun.markStale',
  ToolPolicyScopeSet = 'toolPolicy.scope.set',
  ToolPolicyScopeClear = 'toolPolicy.scope.clear',
  ToolExecutionApprove = 'tool.execution.approve',
  ToolExecutionReject = 'tool.execution.reject',
  ToolChangeApply = 'tool.change.apply',
  ToolChangeReject = 'tool.change.reject',
  ToolResultSubmit = 'tool.result.submit',
  ToolResultReject = 'tool.result.reject',
  ClientResync = 'client.resync',
  ClientSnapshot = 'state.snapshot',
  ClientPatch = 'state.patch',
  RunHistoryPageGet = 'runHistory.page.get',
  RunHistoryPageSnapshot = 'runHistory.page.snapshot',
  RunHistoryDetailGet = 'runHistory.detail.get',
  RunHistoryDetailSnapshot = 'runHistory.detail.snapshot',
  LlmDryRunGet = 'llm.dryRun.get',
  LlmDryRunSnapshot = 'llm.dryRun.snapshot',
  LlmProviderModelsGet = 'llm.providerModels.get',
  LlmProviderModelsSnapshot = 'llm.providerModels.snapshot',
  GlobalSettingsGet = 'settings.global.get',
  GlobalSettingsUpdate = 'settings.global.update',
  GlobalSettingsSnapshot = 'settings.global.snapshot',
  ConversationSettingsGet = 'settings.conversation.get',
  ConversationSettingsUpdate = 'settings.conversation.update',
  ConversationSettingsSnapshot = 'settings.conversation.snapshot',
  ProjectFoldersGet = 'projectFolders.get',
  ProjectFoldersSnapshot = 'projectFolders.snapshot',
  ModeCreate = 'mode.create',
  ModeUpdate = 'mode.update',
  ModeDelete = 'mode.delete',
  ConversationModeSelect = 'conversation.mode.select',
  ConversationAgentSelect = 'conversation.agent.select',
  ConversationProjectSet = 'conversation.project.set',
  WorkEnvironmentSelect = 'workEnvironment.select',
  WorkEnvironmentUpsert = 'workEnvironment.upsert',
  WorkEnvironmentRemove = 'workEnvironment.remove',
  WorkEnvironmentImportFromVscode = 'workEnvironment.importFromVscode',
  WorkEnvironmentPolicyScopeSet = 'workEnvironmentPolicy.scope.set',
  WorkEnvironmentPolicyScopeClear = 'workEnvironmentPolicy.scope.clear'
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
  originKind?: ConversationOriginKind;
  originSourceKind?: AgentRunSourceKind;
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
  'awaiting_change_apply',
  'applying_change',
  'change_applied',
  'change_rejected',
  'awaiting_result_submit',
  'success',
  'warning',
  'error'
] as const;
export type ToolCallStatus = typeof TOOL_CALL_STATUSES[number];
export const TERMINAL_TOOL_CALL_STATUSES: ReadonlySet<ToolCallStatus> = new Set(['success', 'warning', 'error']);

export type ToolExecutionKind = 'runtime' | 'agentRun';
export type ToolSchedulingMode = 'parallel' | 'serial';
export type ToolRiskLevel = 'read' | 'write' | 'command' | 'agent';
export type ToolDefinitionCategory = 'filesystem' | 'command' | 'agent' | 'general';
export type ToolConfigFieldType = 'string' | 'number' | 'boolean' | 'stringList' | 'globList' | 'enum' | 'json';
export type ToolConfigValue = string | number | boolean | null | string[] | number[] | boolean[] | unknown[] | Record<string, unknown>;
export type ToolConfigRecord = Record<string, ToolConfigValue>;

export interface ToolConfigFieldOptionRecord {
  label: string;
  value: string | number | boolean;
  description?: string;
}

export interface ToolConfigFieldRecord {
  key: string;
  label: string;
  type: ToolConfigFieldType;
  description?: string;
  required?: boolean;
  defaultValue?: ToolConfigValue;
  placeholder?: string;
  options?: ToolConfigFieldOptionRecord[];
  sensitive?: boolean;
}

export interface ToolConfigSchemaRecord {
  fields: ToolConfigFieldRecord[];
}

export interface ToolDefinitionMetadataRecord {
  category?: ToolDefinitionCategory;
  riskLevel?: ToolRiskLevel;
  readonly?: boolean;
  defaultEnabled?: boolean;
  requiresApproval?: boolean;
}

export interface ToolDefinitionRecord {
  id: string;
  name: string;
  description: string;
  parameters: unknown;
  execution: ToolExecutionKind;
  metadata?: ToolDefinitionMetadataRecord;
  configSchema?: ToolConfigSchemaRecord;
  defaultConfig?: ToolConfigRecord;
}

export const TASK_LIST_TOOL_NAME = 'update_task_list';
export const SWITCH_WORK_ENVIRONMENT_TOOL_NAME = 'switch_work_environment';
export const TRANSFER_FILES_TOOL_NAME = 'transfer_files';

export const TASK_LIST_ITEM_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'cancelled'
] as const;
export type TaskListItemStatus = typeof TASK_LIST_ITEM_STATUSES[number];
export type TaskListToolMode = 'rewrite' | 'update';

export interface TaskListToolItemRecord {
  /** 面向用户展示的任务标题；update 模式下也作为匹配键。 */
  title: string;
  /** 任务的补充说明、验收条件或上下文。 */
  description?: string;
  /** 任务进行中时适合展示的现在进行时文案。 */
  activeForm?: string;
  /** 不传时前端回放会沿用旧状态；新任务默认 pending。 */
  status?: TaskListItemStatus;
  /** update 模式下删除同标题任务。 */
  delete?: boolean;
}

export interface TaskListToolOperationRecord {
  kind: 'task_list.operation';
  mode: TaskListToolMode;
  items: TaskListToolItemRecord[];
}

export interface TaskListToolOutputRecord {
  kind: 'task_list.result';
  operation: TaskListToolOperationRecord;
  summary: string;
}

export type LlmProviderKind = 'openai-compatible' | 'openai-responses' | 'claude' | 'gemini' | 'deepseek';
export type LlmToolCallFormat = 'function-call';
export type LlmThinkingLevel = 'not-set' | 'non-set' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmThinkingConfigRecord {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: LlmThinkingLevel;
}

export interface LlmGenerationConfigRecord {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  thinkingConfig?: LlmThinkingConfigRecord;
}

export type LlmRequestBodyJsonValue =
  | string
  | number
  | boolean
  | null
  | LlmRequestBodyJsonValue[]
  | { [key: string]: LlmRequestBodyJsonValue };

export type LlmRequestBodyRecord = Record<string, LlmRequestBodyJsonValue>;
export type LlmProviderHeadersRecord = Record<string, string>;

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
  activeProviderConfigId: string;
}

export interface LlmProviderConfigsRecord {
  configs: LlmProviderConfigRecord[];
}

export interface LlmProviderModelRecord {
  id: string;
  name: string;
  createdAt?: string;
}

export interface LlmProviderConfigRecord {
  id: string;
  name: string;
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  models: LlmProviderModelRecord[];
  apiKey: string;
  toolCallFormat: LlmToolCallFormat;
  proxy?: string;
  headers?: LlmProviderHeadersRecord;
  generationConfig?: LlmGenerationConfigRecord;
  requestBody?: LlmRequestBodyRecord;
  createdAt: number;
  updatedAt: number;
}

export type AgentSource = 'builtin' | 'user';

export interface AgentRecord {
  id: string;
  name: string;
  description?: string;
  kind: string;
  source: AgentSource;
  status: 'idle' | 'thinking' | 'running' | 'done' | 'error';
}

export type AgentRunKind = 'chat' | 'tool_invoked' | 'delegated' | 'review' | 'notification' | 'scheduled';
export type AgentRunStatus = 'queued' | 'preparing' | 'running' | 'waiting_tool' | 'waiting_child_run' | 'delivering' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'stale';
export type AgentRunEndReason = 'completed' | 'failed' | 'cancelled_by_user' | 'cancelled_by_policy' | 'stale_source_edited' | 'retry_requested' | 'regenerate_requested';
export type AgentRunErrorType = 'llm' | 'tool' | 'policy' | 'cancelled' | 'stale' | 'unknown';
export type AgentRunSourceKind = 'user' | 'toolCall' | 'agentRun' | 'schedule' | 'system';
export type ConversationOriginKind = 'user' | 'agent' | 'system';
export type AgentRunTargetRole = 'executor';
export type MessageRunRole = 'input' | 'model' | 'tool_response' | 'notification';
export type ToolCallRunRole = 'produced_by';
export type PolicyBindingRole = 'active';
export type ToolPolicyScopeKind = 'global' | 'conversation' | 'agent' | 'agentSystem' | 'mode' | 'run';
export type ConfigScopeKind = 'global' | 'conversation' | 'agent' | 'mode' | 'run';
export type ConfigScopeBindingRole = 'active';

export type ModeSource = 'builtin' | 'user';
export type ModeIconKey = 'list-details';

export interface ModeRecord {
  id: string;
  name: string;
  description?: string;
  source: ModeSource;
  icon?: ModeIconKey;
  createdAt: number;
  updatedAt: number;
}

export type ConversationModeScopeKind = 'global' | 'mode';
export type ConversationModeSelectionRole = 'active';

export interface ToolDisplayPolicyRecord {
  /** true 时前端默认展开该工具调用的内容面板；false/未设置则默认收起。 */
  autoExpand?: boolean;
}

export interface ToolPolicyToolConfigRecord {
  /** 是否自动批准工具进入执行阶段。关闭时会先等待用户批准执行。 */
  autoApproveExecution?: boolean;
  /**
   * 是否自动应用工具生成的可预览更改。
   * 仅对“执行阶段只生成更改提案、应用阶段才产生副作用”的工具有意义；
   * 对 read_file、shell、switch_work_environment 等无更改提案或立即副作用工具无影响。
   */
  autoApplyChange?: boolean;
  /**
   * 是否自动把工具结果提交给 AI，作为后续模型上下文的一部分。
   * 关闭时工具执行/更改应用完成后会等待用户确认结果回传；
   * 用户拒绝时仍会向 AI 回传“用户拒绝使用该结果”的工具响应，避免 AgentRun 永久等待。
   */
  autoSubmitResult?: boolean;
  display?: ToolDisplayPolicyRecord;
  config: ToolConfigRecord;
}


export interface ToolPolicyRecord {
  id: string;
  name: string;
  allowedTools: string[];
  toolConfigs?: Record<string, ToolPolicyToolConfigRecord>;
}

export interface ToolPolicyScopeLinkRecord {
  id: string;
  scopeKind: ToolPolicyScopeKind;
  /** global scope 无 scopeId；agentSystem 当前预留为普通 id；其余 scope 使用对应领域对象 id。 */
  scopeId?: string;
  toolPolicyId: string;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}

export interface SystemPromptRecord {
  id: string;
  name: string;
  text: string;
}

export interface SystemPromptScopeLinkRecord {
  id: string;
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  systemPromptId: string;
  role: ConfigScopeBindingRole;
  order?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ModelProfileRecord {
  id: string;
  name: string;
  providerConfigId?: string;
  provider?: LlmProviderKind;
  model: string;
}

export interface ModelProfileScopeLinkRecord {
  id: string;
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  modelProfileId: string;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationModeSelectionRecord {
  id: string;
  conversationId: string;
  scopeKind: ConversationModeScopeKind;
  modeId?: string;
  role: ConversationModeSelectionRole;
  createdAt: number;
  updatedAt: number;
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


export interface ConversationOriginLinkRecord {
  id: string;
  conversationId: string;
  originKind: ConversationOriginKind;
  sourceKind?: AgentRunSourceKind;
  sourceAgentId?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  sourceToolCallId?: string;
  sourceRunId?: string;
  createdAt: number;
  updatedAt: number;
}


export type AgentConversationRole = 'default' | 'participant' | 'reviewer';

export type ProjectContextKind = 'folder';
export type BuiltinWorkEnvironmentKind = 'localFolder' | 'remoteServer';
export type WorkEnvironmentKind = BuiltinWorkEnvironmentKind | (string & {});
export type WorkEnvironmentSource = 'workspaceFolder' | 'vscodeSshConfig' | 'manual' | (string & {});
export type WorkEnvironmentOs = 'linux' | 'windows' | 'macos' | 'unknown' | string;
export type WorkEnvironmentCapabilityKind = 'localFileRead' | 'localCommand' | 'remoteFileRead' | 'remoteCommand' | 'containerFileRead' | 'containerCommand' | 'fileTransferRead' | 'fileTransferWrite' | (string & {});
export type WorkEnvironmentPolicyScopeKind = 'global' | 'conversation' | 'agent' | 'agentSystem' | 'mode' | 'run';

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

export interface WorkEnvironmentRecord {
  id: string;
  kind: WorkEnvironmentKind;
  name: string;
  /** 本地 folder 使用 VS Code uri；未来远程环境可使用自定义 uri。 */
  uri?: string;
  /** 本地 folder 的可执行根目录；未来远程环境可映射为远程根路径。 */
  rootPath?: string;
  /** 面向 UI / LLM 展示的路径或地址。 */
  displayPath?: string;
  source?: WorkEnvironmentSource;
  /** 环境类型声明的能力；不填时由 kind 的定义提供默认能力。 */
  capabilities?: WorkEnvironmentCapabilityKind[];
  /** provider 专属的非敏感扩展信息，例如未来 Docker container/workspace 映射等。 */
  metadata?: Record<string, unknown>;
  /** SSH Config: Host。 */
  host?: string;
  /** SSH Config: Port，默认 22。 */
  port?: number;
  /** SSH Config: User。 */
  user?: string;
  /** SSH Config: IdentityFile。 */
  identityFile?: string;
  /** 可选明文密码；不会注入 LLM 上下文。 */
  password?: string;
  /** 远端默认工作目录。 */
  workdir?: string;
  os?: WorkEnvironmentOs;
  description?: string;
  /** VS Code workspace folder 顺序；远程环境可不填。 */
  index?: number;
  available: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkEnvironmentPolicyRecord {
  id: string;
  name: string;
  enabled: boolean;
  allowedWorkEnvironmentIds: string[];
  defaultWorkEnvironmentId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkEnvironmentPolicyScopeLinkRecord {
  id: string;
  scopeKind: WorkEnvironmentPolicyScopeKind;
  scopeId?: string;
  workEnvironmentPolicyId: string;
  role: WorkEnvironmentLinkRole;
  createdAt: number;
  updatedAt: number;
}

export type WorkEnvironmentLinkRole = 'active';

export interface ConversationWorkEnvironmentLinkRecord {
  id: string;
  conversationId: string;
  workEnvironmentId: string;
  role: WorkEnvironmentLinkRole;
  createdAt: number;
  updatedAt: number;
}

export interface RunWorkEnvironmentLinkRecord {
  id: string;
  runId: string;
  workEnvironmentId: string;
  role: WorkEnvironmentLinkRole;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConversationLinkRecord {
  id: string;
  agentId: string;
  conversationId: string;
  role: AgentConversationRole;
}

export type ConversationAgentSelectionRole = 'active';

export interface ConversationAgentSelectionRecord {
  id: string;
  conversationId: string;
  agentId: string;
  role: ConversationAgentSelectionRole;
  createdAt: number;
  updatedAt: number;
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
  summary?: string;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  progress?: unknown;
  schedulingMode?: ToolSchedulingMode;
  schedulingReason?: string;
  display?: ToolDisplayPolicyRecord;
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
  toolDefinitions: ToolDefinitionRecord;
  modes: ModeRecord;
  toolPolicies: ToolPolicyRecord;
  toolPolicyScopeLinks: ToolPolicyScopeLinkRecord;
  systemPrompts: SystemPromptRecord;
  systemPromptScopeLinks: SystemPromptScopeLinkRecord;
  modelProfiles: ModelProfileRecord;
  modelProfileScopeLinks: ModelProfileScopeLinkRecord;
  conversationModeSelections: ConversationModeSelectionRecord;
  conversations: ConversationRecord;
  conversationReuseLinks: ConversationReuseLinkRecord;
  conversationBranchLinks: ConversationBranchLinkRecord;
  conversationOriginLinks: ConversationOriginLinkRecord;
  agentConversationLinks: AgentConversationLinkRecord;
  conversationAgentSelections: ConversationAgentSelectionRecord;
  projectContexts: ProjectContextRecord;
  conversationProjectLinks: ConversationProjectLinkRecord;
  workEnvironments: WorkEnvironmentRecord;
  workEnvironmentPolicies: WorkEnvironmentPolicyRecord;
  workEnvironmentPolicyScopeLinks: WorkEnvironmentPolicyScopeLinkRecord;
  conversationWorkEnvironmentLinks: ConversationWorkEnvironmentLinkRecord;
  runWorkEnvironmentLinks: RunWorkEnvironmentLinkRecord;
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
  text?: string;
  content?: MessageContent;
  agentId?: string;
}
export interface ChatAbortPayload {
  conversationId: string;
}
export interface MessageEditPayload {
  conversationId: string;
  messageId: string;
  text?: string;
  content?: MessageContent;
  runAfterEdit?: boolean;
  deleteFollowing?: boolean;
}
export interface ConversationOpenPayload { conversationId: string; title?: string }
export interface AgentCreatePayload { name: string; description?: string; kind?: string }
export interface AgentUpdatePayload { agentId: string; name?: string; description?: string; kind?: string }
export interface AgentDeletePayload { agentId: string }
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
export interface ToolDecisionPayload {
  toolCallId: string;
  conversationId?: string;
  reason?: string;
}
export interface ToolPolicyScopeSetPayload {
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
  name?: string;
  allowedTools: string[];
  toolConfigs?: Record<string, ToolPolicyToolConfigRecord>;
}
export interface ToolPolicyScopeClearPayload {
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
}
export interface SystemPromptScopeSetPayload {
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  name?: string;
  text: string;
  order?: number;
}
export interface SystemPromptScopeClearPayload { scopeKind: ConfigScopeKind; scopeId?: string }
export interface ModelProfileScopeSetPayload {
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  name?: string;
  providerConfigId?: string;
  provider?: LlmProviderKind;
  model: string;
}
export interface ModelProfileScopeClearPayload { scopeKind: ConfigScopeKind; scopeId?: string }
export interface ClientResyncPayload {
  streamId?: string;
  conversationId?: string;
}
export interface ModeCreatePayload {
  name: string;
  description?: string;
}
export interface ModeUpdatePayload {
  modeId: string;
  name?: string;
  description?: string;
}
export interface ModeDeletePayload {
  modeId: string;
}
export type ConversationModeSelectPayload =
  | { conversationId: string; scopeKind: 'global' }
  | { conversationId: string; scopeKind: 'mode'; modeId: string };
export interface ConversationAgentSelectPayload {
  conversationId: string; agentId: string;
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
  inputMessageIds?: string[];
  outputMessageIds?: string[];
  toolCallIds?: string[];
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
  runId?: string;
  messageId?: string;
}

export interface ConversationRunDetailRecord {
  conversationId: string;
  runId: string;
  summary?: ConversationRunSummaryRecord;
  state: ClientState;
}

export interface LlmDryRunGetPayload {
  conversationId: string;
  runId?: string;
  messageId?: string;
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

export interface LlmProviderModelsGetPayload {
  config: LlmProviderConfigRecord;
}

export interface LlmProviderModelsSnapshotPayload {
  configId: string;
  provider: LlmProviderKind;
  baseUrl: string;
  models: LlmProviderModelRecord[];
}


export interface GlobalSettingsRecord {
  dataFilePath: string;
  activeDataRootPath: string;
  defaultDataRootPath: string;
}
export type GlobalSettingsSectionValue = GlobalSettingsRecord | LlmSettingsRecord | LlmProviderConfigsRecord;
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
export interface ConversationLlmSettingsRecord {
  conversationId: string;
  activeProviderConfigId: string;
}
export type ConversationSettingsSectionValue = ConversationSettingsRecord | ConversationLlmSettingsRecord;
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

export interface WorkEnvironmentSelectPayload {
  conversationId: string;
  workEnvironmentId: string;
}

export interface WorkEnvironmentUpsertPayload {
  workEnvironment: WorkEnvironmentRecord;
}

export interface WorkEnvironmentRemovePayload {
  workEnvironmentId: string;
}

export interface WorkEnvironmentImportFromVscodePayload {
  includeDefaultSshConfig?: boolean;
}

export interface WorkEnvironmentPolicyScopeSetPayload {
  scopeKind: WorkEnvironmentPolicyScopeKind;
  scopeId?: string;
  name?: string;
  enabled?: boolean;
  allowedWorkEnvironmentIds: string[];
  defaultWorkEnvironmentId?: string;
}

export interface WorkEnvironmentPolicyScopeClearPayload {
  scopeKind: WorkEnvironmentPolicyScopeKind;
  scopeId?: string;
}

export type WebviewToExtensionMessage =
  | BridgeEnvelope<BridgeMessageType.Ready, undefined>
  | BridgeEnvelope<BridgeMessageType.Ack, BridgeAckPayload>
  | BridgeEnvelope<BridgeMessageType.Ping, { text: string; sentAt: number }>
  | BridgeEnvelope<BridgeMessageType.GetWorkspaceInfo, undefined>
  | BridgeEnvelope<BridgeMessageType.ShowInfo, { message: string }>
  | BridgeEnvelope<BridgeMessageType.ChatSend, ChatSendPayload>
  | BridgeEnvelope<BridgeMessageType.ChatAbort, ChatAbortPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationOpen, ConversationOpenPayload>
  | BridgeEnvelope<BridgeMessageType.AgentCreate, AgentCreatePayload>
  | BridgeEnvelope<BridgeMessageType.AgentUpdate, AgentUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.AgentDelete, AgentDeletePayload>
  | BridgeEnvelope<BridgeMessageType.ConversationAgentSelect, ConversationAgentSelectPayload>
  | BridgeEnvelope<BridgeMessageType.SystemPromptScopeSet, SystemPromptScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.SystemPromptScopeClear, SystemPromptScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.ModelProfileScopeSet, ModelProfileScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.ModelProfileScopeClear, ModelProfileScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.MessageEdit, MessageEditPayload>
  | BridgeEnvelope<BridgeMessageType.MessageDeleteFrom, MessageDeleteFromPayload>
  | BridgeEnvelope<BridgeMessageType.MessageRetryFrom, MessageRetryFromPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunCancel, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunPause, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunResume, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunRetry, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunRegenerate, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.AgentRunMarkStale, AgentRunControlPayload>
  | BridgeEnvelope<BridgeMessageType.ToolPolicyScopeSet, ToolPolicyScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.ToolPolicyScopeClear, ToolPolicyScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.ToolExecutionApprove, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ToolExecutionReject, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ToolChangeApply, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ToolChangeReject, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ToolResultSubmit, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ToolResultReject, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ClientResync, ClientResyncPayload>
  | BridgeEnvelope<BridgeMessageType.RunHistoryPageGet, ConversationRunHistoryPageRequest>
  | BridgeEnvelope<BridgeMessageType.RunHistoryDetailGet, ConversationRunDetailRequest>
  | BridgeEnvelope<BridgeMessageType.LlmDryRunGet, LlmDryRunGetPayload>
  | BridgeEnvelope<BridgeMessageType.LlmProviderModelsGet, LlmProviderModelsGetPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsGet, GlobalSettingsGetPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsUpdate, GlobalSettingsUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsGet, ConversationSettingsGetPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsUpdate, ConversationSettingsUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.ProjectFoldersGet, undefined>
  | BridgeEnvelope<BridgeMessageType.ModeCreate, ModeCreatePayload>
  | BridgeEnvelope<BridgeMessageType.ModeUpdate, ModeUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.ModeDelete, ModeDeletePayload>
  | BridgeEnvelope<BridgeMessageType.ConversationModeSelect, ConversationModeSelectPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationProjectSet, ConversationProjectSetPayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentSelect, WorkEnvironmentSelectPayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentUpsert, WorkEnvironmentUpsertPayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentRemove, WorkEnvironmentRemovePayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentImportFromVscode, WorkEnvironmentImportFromVscodePayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentPolicyScopeSet, WorkEnvironmentPolicyScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentPolicyScopeClear, WorkEnvironmentPolicyScopeClearPayload>;

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
  | BridgeEnvelope<BridgeMessageType.LlmProviderModelsSnapshot, LlmProviderModelsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsSnapshot, GlobalSettingsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsSnapshot, ConversationSettingsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ProjectFoldersSnapshot, ProjectFoldersSnapshotPayload>;

export function createMessageId(): MessageId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
