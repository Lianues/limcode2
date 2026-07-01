import type { CLIENT_STATE_TABLES } from './clientStateSchema';
import type { TimelineProjectionContextRecord } from './timelineProjection';

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
export const GLOBAL_SETTINGS_SECTIONS = ['common', 'llm', 'llmProviderConfigs', 'llmCompression', 'llmCompressionConfigs', 'checkpointMaintenance', 'appearance', 'attachments', 'mcpServers'] as const;
export type GlobalSettingsSection = typeof GLOBAL_SETTINGS_SECTIONS[number];

export function globalSettingsStreamId(section: GlobalSettingsSection): string {
  return `${GLOBAL_SETTINGS_STREAM_PREFIX}${section}`;
}

export const CONVERSATION_SETTINGS_STREAM_PREFIX = 'settings:conversation:';
export const CONVERSATION_SETTINGS_SECTIONS = ['common', 'llm'] as const;
export type ConversationSettingsSection = typeof CONVERSATION_SETTINGS_SECTIONS[number];
export const CONVERSATION_CLIENT_STATE_STREAM_PREFIX = 'conversation:';
export const CONVERSATION_CLIENT_STATE_STREAM_SUFFIX = ':state';
export const CONVERSATION_TIMELINE_STREAM_PREFIX = 'conversation:';
export const CONVERSATION_TIMELINE_STREAM_SUFFIX = ':timeline';

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

export function conversationTimelineStreamId(conversationId: string): string {
  return `${CONVERSATION_TIMELINE_STREAM_PREFIX}${conversationId}${CONVERSATION_TIMELINE_STREAM_SUFFIX}`;
}

export function conversationIdFromClientStateStreamId(streamId: string): string | undefined {
  return streamId.startsWith(CONVERSATION_CLIENT_STATE_STREAM_PREFIX) && streamId.endsWith(CONVERSATION_CLIENT_STATE_STREAM_SUFFIX)
    ? streamId.slice(CONVERSATION_CLIENT_STATE_STREAM_PREFIX.length, -CONVERSATION_CLIENT_STATE_STREAM_SUFFIX.length)
    : undefined;
}

export function conversationIdFromTimelineStreamId(streamId: string): string | undefined {
  return streamId.startsWith(CONVERSATION_TIMELINE_STREAM_PREFIX) && streamId.endsWith(CONVERSATION_TIMELINE_STREAM_SUFFIX)
    ? streamId.slice(CONVERSATION_TIMELINE_STREAM_PREFIX.length, -CONVERSATION_TIMELINE_STREAM_SUFFIX.length)
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
  RuntimeContextScopeSet = 'runtimeContext.scope.set',
  RuntimeContextScopeClear = 'runtimeContext.scope.clear',
  RuntimeContextRefresh = 'runtimeContext.refresh',
  RuntimeContextSnapshotClear = 'runtimeContext.snapshot.clear',
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
  QueuePromote = 'queue.promote',
  QueueRemove = 'queue.remove',
  QueueReorder = 'queue.reorder',
  QueuePause = 'queue.pause',
  QueueResume = 'queue.resume',
  QueueResumeAll = 'queue.resumeAll',
  QueueInputUpdate = 'queue.input.update',
  ToolPolicyScopeSet = 'toolPolicy.scope.set',
  ToolPolicyScopeClear = 'toolPolicy.scope.clear',
  SkillPolicyScopeSet = 'skillPolicy.scope.set',
  SkillPolicyScopeClear = 'skillPolicy.scope.clear',
  SkillCatalogRefresh = 'skill.catalog.refresh',
  ToolExecutionApprove = 'tool.execution.approve',
  ToolExecutionReject = 'tool.execution.reject',
  ToolChangeApply = 'tool.change.apply',
  ToolChangeReject = 'tool.change.reject',
  ToolResultSubmit = 'tool.result.submit',
  ToolResultReject = 'tool.result.reject',
  CheckpointDiffOpen = 'checkpoint.diff.open',
  AttachmentOpen = 'attachment.open',
  AttachmentReload = 'attachment.reload',
  AttachmentReloadResult = 'attachment.reload.result',
  CheckpointDiffOpenResult = 'checkpoint.diff.open.result',
  EditToolStatisticsGet = 'editTool.statistics.get',
  EditToolStatisticsSnapshot = 'editTool.statistics.snapshot',
  ClientResync = 'client.resync',
  ClientSnapshot = 'state.snapshot',
  ClientPatch = 'state.patch',
  ConversationTimelinePageGet = 'conversationTimeline.page.get',
  ConversationTimelinePageSnapshot = 'conversationTimeline.page.snapshot',
  ConversationTimelinePatch = 'conversationTimeline.patch',
  ConversationTimelineMetaSnapshot = 'conversationTimeline.meta.snapshot',
  RunHistoryPageGet = 'runHistory.page.get',
  RunHistoryPageSnapshot = 'runHistory.page.snapshot',
  RunHistoryDetailGet = 'runHistory.detail.get',
  RunHistoryDetailSnapshot = 'runHistory.detail.snapshot',
  LlmDryRunGet = 'llm.dryRun.get',
  LlmDryRunSnapshot = 'llm.dryRun.snapshot',
  LlmRetryCancel = 'llm.retry.cancel',
  LlmTransientNotice = 'llm.transient.notice',
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
  WorkEnvironmentPolicyScopeClear = 'workEnvironmentPolicy.scope.clear',
  CheckpointPolicyScopeSet = 'checkpointPolicy.scope.set',
  CheckpointPolicyScopeClear = 'checkpointPolicy.scope.clear',
  CheckpointGitStatusGet = 'checkpoint.gitStatus.get',
  CheckpointGitStatusSnapshot = 'checkpoint.gitStatus.snapshot',
  CheckpointShadowStatsGet = 'checkpoint.shadowStats.get',
  CheckpointShadowStatsSnapshot = 'checkpoint.shadowStats.snapshot',
  CheckpointShadowDelete = 'checkpoint.shadow.delete',
  CheckpointDismiss = 'checkpoint.dismiss',
  CheckpointRestore = 'checkpoint.restore',
  CheckpointRestoreResult = 'checkpoint.restore.result',
  CompressionCreate = 'compression.create',
  CompressionDelete = 'compression.delete',
  CompressionUpdate = 'compression.update',
  CompressionRegenerate = 'compression.regenerate',
  CompressionDisable = 'compression.disable',
  CompressionEnable = 'compression.enable',
  FsStatGet = 'fs.stat.get',
  FsStatResult = 'fs.stat.result'
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

export interface FsStatGetPayload {
  paths: string[];
}

export interface FsStatResultPayload {
  results: FsStatResultEntry[];
}

export interface FsStatResultEntry {
  path: string;
  isDirectory: boolean;
  exists: boolean;
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
export type ToolDomainScope = 'agent' | 'file' | 'command' | 'conversation' | 'workEnvironment' | 'task' | 'skill' | 'general';
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
  /** 工具领域分类，不是 ToolPolicyScopeKind。用于设置页分组、筛选与隐藏显示。 */
  scope?: ToolDomainScope;
  riskLevel?: ToolRiskLevel;
  readonly?: boolean;
  defaultEnabled?: boolean;
  requiresApproval?: boolean;
  defaultAutoExpand?: boolean;
  defaultAutoApproveExecution?: boolean;
  defaultAutoApplyChange?: boolean;
  defaultAutoSubmitResult?: boolean;
  checkpoint?: Partial<CheckpointToolTriggerConfigRecord>;
}

export interface ToolDefinitionRecord {
  id: string;
  name: string;
  description: string;
  parameters: unknown;
  execution: ToolExecutionKind;
  source?: ToolDefinitionSourceRecord;
  metadata?: ToolDefinitionMetadataRecord;
  configSchema?: ToolConfigSchemaRecord;
  defaultConfig?: ToolConfigRecord;
}

export interface ToolDefinitionSourceRecord {
  kind: 'builtin' | 'mcp';
  sourceId?: string;
  sourceName?: string;
  originalToolName?: string;
}

export const TASK_LIST_TOOL_NAME = 'update_task_list';
export const SWITCH_WORK_ENVIRONMENT_TOOL_NAME = 'switch_work_environment';
export const TRANSFER_TOOL_NAME = 'transfer';
export const READ_TOOL_NAME = 'read';
export const EDIT_TOOL_NAME = 'edit';
export const WRITE_TOOL_NAME = 'write';
export const DELETE_TOOL_NAME = 'delete';
export const ALLOW_OUTSIDE_PROJECT_PATHS_CONFIG_KEY = 'allowOutsideProjectPaths';
export const SUBMIT_AGENT_ANSWER_TOOL_NAME = 'submit_agent_answer';
export const READ_AGENT_ANSWER_TOOL_NAME = 'read_agent_answer';
export const SKILLS_TOOL_NAME = 'skills';

export type EditToolMode = 'patch' | 'hunk' | 'insert' | 'delete';

export interface EditToolModeStatisticsRecord {
  mode: EditToolMode;
  attempts: number;
  successes: number;
  failures: number;
  successRate: number;
  updatedAt?: number;
}

export interface EditToolStatisticsRecord {
  modes: Record<EditToolMode, EditToolModeStatisticsRecord>;
  updatedAt: number;
}

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

export type LlmCompressionMethodKind = 'disabled' | 'openai_responses_compact' | 'llm_summary' | 'segmented_summary' | 'deterministic_summary' | 'manual_summary';
export type LlmCompressionTriggerMode = 'manual' | 'token_threshold';
export type LlmCompressionFallbackMode = 'use_summary' | 'use_raw_history' | 'block_and_ask' | 'auto_generate_summary';
export type LlmCompressionThresholdUnit = 'percent' | 'tokens';

export const DEFAULT_LLM_CONTEXT_WINDOW_TOKENS = 200_000;
export const DEFAULT_LLM_RETRY_ON_ERROR = true;
export const DEFAULT_LLM_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT = 90;
export const DEFAULT_LLM_COMPRESSION_RESERVE_TOKENS = 20_000;
export const DEFAULT_LLM_COMPRESSION_SUMMARY_SYSTEM_PROMPT = 'You have written a partial transcript for the initial task above. Please write a summary of the transcript. The purpose of this summary is to provide continuity so you can continue to make progress towards solving the task in a future context, where the raw history above may not be accessible and will be replaced with this summary. Write down anything that would be helpful, including the state, next steps, learnings etc. You must wrap your summary in a <summary></summary> block.';
export const DEFAULT_LLM_COMPRESSION_SUMMARY_USER_PROMPT = 'Transcript:';
export const DEFAULT_SEGMENTED_SUMMARY_SYSTEM_PROMPT = [
  '你正在对一段很长的对话做“分段”压缩。下面【本回合记录】是对话中的一个回合的完整记录',
  '(一个回合 = 从一条用户消息开始，到下一条用户消息之前为止，中间包含模型的思考、工具调用、工具结果和文字回复)。',
  '请把这个回合压缩成简洁但信息完整、可在未来上下文中替代原文使用的摘要。',
  '',
  '必须包含：',
  '- 本回合中用户的意图/请求',
  '- 模型采取的主要动作(调用了哪些工具、关键参数、返回的主要结果)',
  '- 得出的结论/决定/查明的事实',
  '- 回合结束时的状态与遗留任务/下一步',
  '',
  '规则：',
  '- 只总结本回合。“前情”仅用于保持连贯的只读参考，不要重新总结它。',
  '- 文件路径、函数名、标识符、数字等关键细节要按原文保留，不要编造。',
  '- 输出连贯的纯文本段落，不要使用 Markdown 标题(#)，以免与拼接时的分段标题冲突。',
  '- 必须把最终摘要用 <summary></summary> 标签包裹，标签外不要写其它内容。'
].join('\n');
export const DEFAULT_SEGMENTED_SUMMARY_USER_PROMPT = '请总结下面这个回合。';

export interface LlmCompressionSettingsRecord {
  defaultConfigId?: string;
  providerBindings: LlmCompressionProviderBindingRecord[];
}

export interface LlmCompressionProviderBindingRecord {
  id: string;
  providerConfigId: string;
  compressionConfigId: string;
  role: 'default';
  createdAt: number;
  updatedAt: number;
}

export interface LlmCompressionConfigsRecord {
  configs: LlmCompressionConfigRecord[];
}

export interface LlmCompressionConfigRecord {
  id: string;
  name: string;
  kind: LlmCompressionMethodKind;
  trigger: {
    mode: LlmCompressionTriggerMode;
    thresholdTokens?: number;
    thresholdPercent?: number;
    thresholdUnit?: LlmCompressionThresholdUnit;
    preserveLatestMessages?: number;
    reserveLatestUserMessageTokens?: number;
  };
  openaiResponsesCompact?: {
    providerConfigId?: string;
    model?: string;
    createSummaryFallback?: boolean;
    fallbackConfigId?: string;
  };
  llmSummary?: {
    providerConfigId?: string;
    model?: string;
    systemPrompt?: string;
    userPrompt?: string;
    targetTokens?: number;
    generationConfig?: LlmGenerationConfigRecord;
  };
  fallbackPolicy: {
    whenNativeUnavailable: LlmCompressionFallbackMode;
  };
  createdAt: number;
  updatedAt: number;
}

export function createDefaultLlmCompressionSettings(): LlmCompressionSettingsRecord {
  return { providerBindings: [] };
}

export function createDefaultLlmCompressionConfig(name = '默认压缩方法'): LlmCompressionConfigRecord {
  const now = Date.now();
  return {
    id: `llm-compression-config-${createMessageId()}`,
    name,
    kind: 'segmented_summary',
    trigger: {
      mode: 'token_threshold',
      thresholdUnit: 'percent',
      thresholdPercent: DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT,
      preserveLatestMessages: 8,
      reserveLatestUserMessageTokens: DEFAULT_LLM_COMPRESSION_RESERVE_TOKENS
    },
    llmSummary: {
      targetTokens: 2000
    },
    fallbackPolicy: { whenNativeUnavailable: 'use_summary' },
    createdAt: now,
    updatedAt: now
  };
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
  stream: boolean;
  /** 请求报错时是否自动重试。 */
  retryOnError: boolean;
  /** 最大重试次数，不包含原始请求；3 表示最多 1 + 3 次请求，-1 表示无限重试。 */
  retryMaxAttempts: number;
  contextWindowTokens?: number;
  headers?: LlmProviderHeadersRecord;
  generationConfig?: LlmGenerationConfigRecord;
  requestBody?: LlmRequestBodyRecord;
  createdAt: number;
  updatedAt: number;
}

export type LlmInvocationStatus = 'resolving' | 'ready' | 'streaming' | 'complete' | 'error' | 'cancelled';
export type RunLlmInvocationRole = 'primary';
export type MessageLlmInvocationRole = 'modelOutput';
export type CompressionBlockLlmInvocationRole = 'compact';

export interface LlmInvocationSettingsSnapshotRecord {
  providerConfigId?: string;
  providerConfigName?: string;
  provider?: LlmProviderKind;
  baseUrl?: string;
  modelId?: string;
  modelName?: string;
  displayModelName?: string;
  toolCallFormat?: LlmToolCallFormat;
  stream?: boolean;
  retryOnError?: boolean;
  retryMaxAttempts?: number;
  contextWindowTokens?: number;
  generationConfig?: LlmGenerationConfigRecord;
  requestBody?: LlmRequestBodyRecord;
  compressionConfigId?: string;
  compressionMethodKind?: LlmCompressionMethodKind;
  compressionTrigger?: LlmCompressionConfigRecord['trigger'];
  /** header 名保留；敏感值会被 mask，不持久化真实 secret。 */
  headers?: LlmProviderHeadersRecord;
}

export interface LlmInvocationRecord {
  id: string;
  requestId: string;
  status: LlmInvocationStatus;
  settings?: LlmInvocationSettingsSnapshotRecord;
  createdAt: number;
  resolvedAt?: number;
  startedAt?: number;
  completedAt?: number;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  error?: string;
}

export interface RunLlmInvocationLinkRecord {
  id: string;
  runId: string;
  invocationId: string;
  role: RunLlmInvocationRole;
  createdAt: number;
  updatedAt: number;
}

export interface MessageLlmInvocationLinkRecord {
  id: string;
  messageId: string;
  invocationId: string;
  role: MessageLlmInvocationRole;
  createdAt: number;
  updatedAt: number;
}

export interface CompressionBlockLlmInvocationLinkRecord {
  id: string;
  blockId: string;
  invocationId: string;
  role: CompressionBlockLlmInvocationRole;
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
export type AgentRunQueueHoldReason = 'restored' | 'manual';

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
   * 对 read、shell、switch_work_environment 等无更改提案或立即副作用工具无影响。
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

export interface ToolPolicySourceConfigRecord {
  enabled: boolean;
  disabledTools?: string[];
}

export interface ToolPolicyRecord {
  id: string;
  name: string;
  allowedTools: string[];
  toolConfigs?: Record<string, ToolPolicyToolConfigRecord>;
  sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>;
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

/** 技能来源：local=项目 .agents/skills/；global=数据根 skills/。 */
export type SkillSource = 'local' | 'global';
/** 技能策略作用域，与 ToolPolicyScopeKind 保持一致，便于不同 scope 复用配置。 */
export type SkillPolicyScopeKind = ToolPolicyScopeKind;

/** 磁盘扫描出的技能定义。不落 record-store，来自 SkillCatalog 资源投影，类似 ToolDefinitionRecord。 */
export interface SkillDefinitionRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  dir: string;
  workspaceFolderUri?: string;
}

/** 单个来源分组的技能开关配置：组总开关 + 组内被停用技能 id。 */
export interface SkillPolicySourceConfigRecord {
  enabled: boolean;
  disabledSkills?: string[];
}

export interface SkillPolicyRecord {
  id: string;
  name: string;
  sourceConfigs?: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>>;
}

export interface SkillPolicyScopeLinkRecord {
  id: string;
  scopeKind: SkillPolicyScopeKind;
  /** global scope 无 scopeId；agentSystem 当前预留为普通 id；其余 scope 使用对应领域对象 id。 */
  scopeId?: string;
  skillPolicyId: string;
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

export type PromptPlaceholderTarget = 'systemPrompt' | 'runtimeContext';

export interface PromptPlaceholderRecord {
  id: string;
  token: string;
  label: string;
  description?: string;
  target: PromptPlaceholderTarget;
  order?: number;
}

export interface RuntimeContextRecord {
  id: string;
  name: string;
  template: string;
}

export interface RuntimeContextScopeLinkRecord {
  id: string;
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  runtimeContextId: string;
  role: ConfigScopeBindingRole;
  order?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeContextSnapshotRecord {
  id: string;
  name: string;
  text: string;
  template: string;
  conversationId?: string;
  sourceRuntimeContextIds?: string[];
  sourceHash?: string;
  createdAt: number;
  updatedAt: number;
  refreshedAt: number;
}

export interface ConversationRuntimeContextSnapshotLinkRecord {
  id: string;
  conversationId: string;
  runtimeContextSnapshotId: string;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}

export interface RunRuntimeContextSnapshotLinkRecord {
  id: string;
  runId: string;
  runtimeContextSnapshotId: string;
  role: 'context';
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

export type CheckpointPolicyScopeKind = ConfigScopeKind;
export type CheckpointRepositoryLinkRole = 'active' | 'history';
export type CheckpointStatus = 'pending' | 'created' | 'skipped' | 'failed';
export type CheckpointSkipReason =
  | 'disabled'
  | 'trigger_disabled'
  | 'no_project'
  | 'workspace_not_containing_project'
  | 'initial_size_exceeded'
  | 'no_changes'
  | 'git_unavailable'
  | 'unsupported_project_uri'
  | 'io_error';
export type CheckpointTriggerKind =
  | 'conversation_initial'
  | 'user_message_before'
  | 'user_message_after'
  | 'llm_response_before'
  | 'llm_response_after'
  | 'tool_execution_before'
  | 'tool_execution_after'
  | 'agent_run_completed_before'
  | 'agent_run_completed_after'
  | 'manual';

export interface CheckpointTriggerConfigRecord {
  conversationInitial: boolean;
  userMessageBefore: boolean;
  userMessageAfter: boolean;
  llmResponseBefore: boolean;
  llmResponseAfter: boolean;
  agentRunCompletedBefore: boolean;
  agentRunCompletedAfter: boolean;
  manual: boolean;
}

export interface CheckpointToolTriggerConfigRecord {
  before: boolean;
  after: boolean;
}

export interface CheckpointPolicyRecord {
  id: string;
  name: string;
  enabled: boolean;
  initialSnapshotMaxBytes: number;
  preserveEmptyDirectories: boolean;
  useGitignore: boolean;
  skipPatterns: string[];
  triggers: CheckpointTriggerConfigRecord;
  toolTriggers: Record<string, CheckpointToolTriggerConfigRecord>;
  createdAt: number;
  updatedAt: number;
}

export interface CheckpointGitStatusRecord {
  available: boolean;
  checkedAt: number;
  version?: string;
  message?: string;
}

export interface CheckpointGitStatusSnapshotPayload { status: CheckpointGitStatusRecord }

export interface ShadowRepositoryDiskStatRecord {
  storageKey: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  lastActiveAt?: number;
}

export interface CheckpointShadowStatsSnapshotPayload { stats: ShadowRepositoryDiskStatRecord[] }

export interface CheckpointShadowDeletePayload { storageKeys: string[] }

export interface CheckpointDismissPayload { checkpointId: string; conversationId: string }

export interface CheckpointRestorePayload {
  checkpointId: string;
  conversationId: string;
  shadowRepositoryStorageKey: string;
  commitSha: string;
  projectUri: string;
  policy: CheckpointPolicyRecord;
}

export interface ShadowCheckpointRestoreResult {
  status: 'restored' | 'failed';
  message: string;
  restoredFileCount?: number;
  removedFileCount?: number;
}

export interface CheckpointRestoreResultPayload {
  checkpointId: string;
  conversationId: string;
  result: ShadowCheckpointRestoreResult;
}

export interface CheckpointDiffOpenPayload {
  conversationId: string;
  checkpointId: string;
  filePath: string;
}

export interface CheckpointDiffOpenResultPayload {
  conversationId: string;
  checkpointId: string;
  filePath: string;
  status: 'opened' | 'failed';
  message: string;
}

export interface EditToolStatisticsSnapshotPayload { statistics: EditToolStatisticsRecord }

export interface CheckpointPolicyScopeLinkRecord {
  id: string;
  scopeKind: CheckpointPolicyScopeKind;
  scopeId?: string;
  checkpointPolicyId: string;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}

export interface ShadowRepositoryRecord {
  id: string;
  storageKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationCheckpointRepositoryLinkRecord {
  id: string;
  conversationId: string;
  projectContextId: string;
  shadowRepositoryId: string;
  projectUri: string;
  projectDisplayPath: string;
  role: CheckpointRepositoryLinkRole;
  createdAt: number;
  updatedAt: number;
}

export interface CheckpointRecord {
  id: string;
  conversationId: string;
  projectContextId: string;
  shadowRepositoryId: string;
  trigger: CheckpointTriggerKind;
  status: CheckpointStatus;
  projectUri: string;
  projectDisplayPath: string;
  createdAt: number;
  updatedAt: number;
  commitSha?: string;
  skipReason?: CheckpointSkipReason;
  message?: string;
  fileCount?: number;
  byteCount?: number;
  emptyDirectoryCount?: number;
}

export type CheckpointFloorAnchorPosition = 'before' | 'after';

export interface CheckpointTimelineAnchorRecord {
  id: string;
  conversationId: string;
  checkpointId: string;
  floorMessageId: string;
  position: CheckpointFloorAnchorPosition;
  order: number;
  sourceRunId?: string;
  sourceToolCallId?: string;
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
    parts?: InlineDataPart[];
  };
  durationMs?: number;
}

export type AttachmentStorageMode = 'embedded' | 'managed' | 'localPath';
export type AttachmentAvailabilityStatus = 'available' | 'loading' | 'missing' | 'tooLarge' | 'unsupported' | 'failed';

export interface AttachmentRecord {
  id: string;
  mimeType: string;
  name?: string;
  sizeBytes: number;
  base64Bytes: number;
  sha256: string;
  blobFile: string;
  createdAt: number;
  updatedAt: number;
}

export interface InlineDataPart {
  inlineData: {
    mimeType: string;
    /** 运行时可用的纯 base64；持久化时小附件会外置到 attachments/blobs。 */
    data?: string;
    /** 原始文件名；OpenAI Responses input_file 会作为 filename 发送。 */
    name?: string;
    /** 托管附件 id，指向 <dataRoot>/attachments。 */
    attachmentId?: string;
    /** 超过托管阈值或用户选择本地引用时的源文件绝对路径。 */
    sourcePath?: string;
    storage?: AttachmentStorageMode;
    status?: AttachmentAvailabilityStatus;
    error?: string;
    sizeBytes?: number;
  };
}

export interface FileDataPart {
  fileData: { mimeType?: string; uri: string };
}

export interface ProviderContextPart {
  providerContext: {
    provider: string;
    format: string;
    endpoint?: string;
    itemType?: string;
    encryptedContent?: string;
    rawItem?: unknown;
  };
}

export type ContentPart = TextPart | FunctionCallPart | FunctionResponsePart | InlineDataPart | FileDataPart | ProviderContextPart;

export function isTextPart(part: ContentPart): part is TextPart { return 'text' in part; }
export function isVisibleTextPart(part: ContentPart): part is TextPart { return isTextPart(part) && part.thought !== true; }
export function isFunctionCallPart(part: ContentPart): part is FunctionCallPart { return 'functionCall' in part; }
export function isFunctionResponsePart(part: ContentPart): part is FunctionResponsePart { return 'functionResponse' in part; }
export function isInlineDataPart(part: ContentPart): part is InlineDataPart { return 'inlineData' in part; }
export function isFileDataPart(part: ContentPart): part is FileDataPart { return 'fileData' in part; }
export function isProviderContextPart(part: ContentPart): part is ProviderContextPart { return 'providerContext' in part; }

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
  model?: string;
  content: MessageContent;
  status: MsgStatus;
  createdAt: number;
  requestStartedAt?: number;
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
  answerBridgeId?: string;
}

export interface AgentRunTargetLinkRecord {
  id: string;
  runId: string;
  agentId: string;
  conversationId: string;
  role: AgentRunTargetRole;
}

export interface AgentRunQueueOrderRecord {
  id: string;
  runId: string;
  conversationId: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRunQueueHoldRecord {
  id: string;
  runId: string;
  conversationId: string;
  reason: AgentRunQueueHoldReason;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRunQueuedInputRecord {
  id: string;
  runId: string;
  conversationId: string;
  content: MessageContent;
  createdAt: number;
  updatedAt: number;
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

export interface AgentAnswerRecord {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentAnswerSubmissionLinkRecord {
  id: string;
  answerId: string;
  submitterRunId?: string;
  submitterAgentId?: string;
  submitterConversationId?: string;
  submitterToolCallId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentAnswerTargetLinkRecord {
  id: string;
  answerId: string;
  targetRunId?: string;
  targetAgentId?: string;
  targetConversationId?: string;
  sourceToolCallId?: string;
  createdAt: number;
  updatedAt: number;
}

export type CompressionBlockStatus = 'pending' | 'running' | 'complete' | 'error' | 'stale' | 'disabled';
export type CompressionBlockSourceKind = 'message' | 'compressionBlock';
export type CompressionBlockSourceRole = 'source' | 'retained' | 'anchor';
export type CompressionContextVariantKind = 'provider_native' | 'provider_neutral_summary';
export type CompressionContextUseMode = 'provider_native' | 'summary_fallback' | 'raw_history_fallback';

export interface CompressionBlockRecord {
  id: string;
  conversationId: string;
  title: string;
  status: CompressionBlockStatus;
  methodKind: LlmCompressionMethodKind;
  methodConfigId?: string;
  anchorMessageId?: string;
  anchorSeq?: number;
  startSeq?: number;
  endSeq?: number;
  sourceMessageCount?: number;
  summaryPreview?: string;
  tokenCountBefore?: number;
  tokenCountAfter?: number;
  tokenSaved?: number;
  sourceHash?: string;
  staleReason?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CompressionBlockSourceLinkRecord {
  id: string;
  blockId: string;
  sourceKind: CompressionBlockSourceKind;
  sourceId: string;
  revisionId?: string;
  role: CompressionBlockSourceRole;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface CompressionContextVariantRecord {
  id: string;
  blockId: string;
  kind: CompressionContextVariantKind;
  contents: MessageContent[];
  compatibility?: {
    provider?: LlmProviderKind;
    providerConfigId?: string;
    baseUrl?: string;
    model?: string;
    format?: string;
    endpoint?: string;
  };
  usageMetadata?: LlmUsageMetadataRecord;
  rawResponse?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface RunCompressionBlockLinkRecord {
  id: string;
  runId: string;
  blockId: string;
  variantId?: string;
  role: 'context';
  mode: CompressionContextUseMode;
  createdAt: number;
  updatedAt: number;
}

export interface CompressionCreatePayload {
  conversationId: string;
  startMessageId?: string;
  endMessageId?: string;
  methodConfigId?: string;
  methodKind?: LlmCompressionMethodKind;
  trigger?: 'manual' | 'auto';
}

export interface CompressionDeletePayload { conversationId: string; blockId: string }
export interface CompressionUpdatePayload { conversationId: string; blockId: string; title?: string; summaryPreview?: string; summaryContents?: MessageContent[] }
export interface CompressionRegeneratePayload { conversationId: string; blockId: string; methodConfigId?: string }
export interface CompressionTogglePayload { conversationId: string; blockId: string }

export interface ClientStateRecordByTable {
  agents: AgentRecord;
  toolDefinitions: ToolDefinitionRecord;
  mcpToolSources: McpToolSourceRecord;
  modes: ModeRecord;
  toolPolicies: ToolPolicyRecord;
  toolPolicyScopeLinks: ToolPolicyScopeLinkRecord;
  skillDefinitions: SkillDefinitionRecord;
  skillPolicies: SkillPolicyRecord;
  skillPolicyScopeLinks: SkillPolicyScopeLinkRecord;
  systemPrompts: SystemPromptRecord;
  systemPromptScopeLinks: SystemPromptScopeLinkRecord;
  promptPlaceholders: PromptPlaceholderRecord;
  runtimeContexts: RuntimeContextRecord;
  runtimeContextScopeLinks: RuntimeContextScopeLinkRecord;
  runtimeContextSnapshots: RuntimeContextSnapshotRecord;
  conversationRuntimeContextSnapshotLinks: ConversationRuntimeContextSnapshotLinkRecord;
  runRuntimeContextSnapshotLinks: RunRuntimeContextSnapshotLinkRecord;
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
  checkpointPolicies: CheckpointPolicyRecord;
  checkpointPolicyScopeLinks: CheckpointPolicyScopeLinkRecord;
  shadowRepositories: ShadowRepositoryRecord;
  conversationCheckpointRepositoryLinks: ConversationCheckpointRepositoryLinkRecord;
  checkpoints: CheckpointRecord;
  checkpointTimelineAnchors: CheckpointTimelineAnchorRecord;
  messages: MessageRecord;
  messageRevisions: MessageRevisionRecord;
  messageCurrentRevisionLinks: MessageCurrentRevisionLinkRecord;
  llmInvocations: LlmInvocationRecord;
  runLlmInvocationLinks: RunLlmInvocationLinkRecord;
  messageLlmInvocationLinks: MessageLlmInvocationLinkRecord;
  compressionBlocks: CompressionBlockRecord;
  compressionBlockSourceLinks: CompressionBlockSourceLinkRecord;
  compressionContextVariants: CompressionContextVariantRecord;
  runCompressionBlockLinks: RunCompressionBlockLinkRecord;
  compressionBlockLlmInvocationLinks: CompressionBlockLlmInvocationLinkRecord;
  toolCalls: ToolCallRecord;
  toolCallEvents: ToolCallEventRecord;
  agentRuns: AgentRunRecord;
  agentRunSourceLinks: AgentRunSourceLinkRecord;
  agentRunTargetLinks: AgentRunTargetLinkRecord;
  agentRunQueueOrders: AgentRunQueueOrderRecord;
  agentRunQueueHolds: AgentRunQueueHoldRecord;
  agentRunQueuedInputs: AgentRunQueuedInputRecord;
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
  agentAnswers: AgentAnswerRecord;
  agentAnswerSubmissionLinks: AgentAnswerSubmissionLinkRecord;
  agentAnswerTargetLinks: AgentAnswerTargetLinkRecord;
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
export interface LlmRetryCancelPayload {
  requestId: string;
  conversationId?: string;
  messageId?: string;
  runId?: string;
  reason?: string;
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
export interface QueuePromotePayload {
  conversationId: string;
  runId: string;
}
export interface QueueRemovePayload {
  conversationId: string;
  runId: string;
}
export interface QueueReorderPayload {
  conversationId: string;
  runIds: string[];
}
export interface QueuePausePayload {
  conversationId: string;
  runId: string;
}
export interface QueueResumePayload {
  conversationId: string;
  runId: string;
}
export interface QueueResumeAllPayload {
  conversationId: string;
}
export interface QueueInputUpdatePayload {
  conversationId: string;
  runId: string;
  text?: string;
  content?: MessageContent;
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
  sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>;
}
export interface ToolPolicyScopeClearPayload {
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
}
export interface SkillPolicyScopeSetPayload {
  scopeKind: SkillPolicyScopeKind;
  scopeId?: string;
  name?: string;
  sourceConfigs?: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>>;
}
export interface SkillPolicyScopeClearPayload {
  scopeKind: SkillPolicyScopeKind;
  scopeId?: string;
}
export interface CheckpointPolicyScopeSetPayload {
  scopeKind: CheckpointPolicyScopeKind;
  scopeId?: string;
  name?: string;
  enabled?: boolean;
  initialSnapshotMaxBytes?: number;
  preserveEmptyDirectories?: boolean;
  useGitignore?: boolean;
  skipPatterns?: string[];
  triggers?: Partial<CheckpointTriggerConfigRecord>;
  toolTriggers?: Record<string, Partial<CheckpointToolTriggerConfigRecord>>;
}
export interface CheckpointPolicyScopeClearPayload {
  scopeKind: CheckpointPolicyScopeKind;
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
export interface RuntimeContextScopeSetPayload {
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  name?: string;
  template: string;
  order?: number;
}
export interface RuntimeContextScopeClearPayload { scopeKind: ConfigScopeKind; scopeId?: string }
export interface RuntimeContextRefreshPayload {
  conversationId?: string;
  runId?: string;
  scopeKind?: ConfigScopeKind;
  scopeId?: string;
}
export interface RuntimeContextSnapshotClearPayload {
  conversationId?: string;
  runId?: string;
}
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

export type ConversationTimelinePageDirection = 'initial' | 'older' | 'newer' | 'around';
export type ConversationTimelinePageApplyMode = 'replace' | 'prepend' | 'append' | 'merge';

export interface ConversationTimelinePageRequest {
  conversationId: string;
  direction?: ConversationTimelinePageDirection;
  cursor?: string;
  anchorMessageId?: string;
  chunkCount?: number;
  includeProjections?: string[];
}

export interface ConversationTimelineChunkSummaryRecord {
  id: string;
  index: number;
  startSeq: number;
  endSeq: number;
  messageCount: number;
  messageOffsetStart: number;
  messageOffsetEnd: number;
  toolCallCount: number;
  toolCallEventCount: number;
}

export interface ConversationTimelinePageInfo {
  conversationId: string;
  chunkIds: string[];
  totalChunks: number;
  totalMessages: number;
  startSeq?: number;
  endSeq?: number;
  oldestChunkId?: string;
  newestChunkId?: string;
  previousCursor?: string;
  nextCursor?: string;
  hasOlder: boolean;
  hasNewer: boolean;
  loadedAt: number;
}

export interface ConversationTimelinePageRecord {
  conversationId: string;
  applyMode: ConversationTimelinePageApplyMode;
  chunks: ConversationTimelineChunkSummaryRecord[];
  pageInfo: ConversationTimelinePageInfo;
  state: ClientState;
  projections?: Record<string, TimelineProjectionContextRecord>;
}

export interface ConversationTimelinePatchPayload {
  conversationId: string;
  streamSeq: number;
  patches: ClientPatchOp[];
  pageInfo?: Partial<ConversationTimelinePageInfo>;
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

export interface LlmRawErrorInfoRecord {
  kind?: string;
  status?: number;
  headers?: Record<string, unknown>;
  bodyText?: string;
  rawBody?: unknown;
  rawChunk?: unknown;
  rawResponse?: unknown;
  data?: unknown;
  message?: string;
  [key: string]: unknown;
}

export type LlmTransientNoticeKind =
  | 'retryScheduled'
  | 'retryStarted'
  | 'retryCancelled'
  | 'retryRecovered'
  | 'error';

export interface LlmTransientNoticePayload {
  id: string;
  kind: LlmTransientNoticeKind;
  conversationId: string;
  messageId: string;
  requestId: string;
  runId?: string;
  invocationId?: string;
  message: string;
  rawError?: LlmRawErrorInfoRecord;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  retryDelayMs?: number;
  createdAt: number;
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
  invocationId?: string;
  compressionBlockId?: string;
  /** true 时 curl 中显示 API Key；默认 false，避免泄漏密钥。 */
  includeApiKey?: boolean;
}

export interface LlmDryRunSnapshotPayload {
  conversationId: string;
  runId?: string;
  compressionBlockId?: string;
  invocationId?: string;
  settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
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
  /** 当前是否能从配置中取到真实 API Key；false 时 dry-run 使用占位 key 生成请求结构。 */
  apiKeyAvailable?: boolean;
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
  proxy: string;
  activeDataRootPath: string;
  defaultDataRootPath: string;
}
export interface CheckpointMaintenanceSettingsRecord {
  autoCleanupEnabled: boolean;
  autoCleanupDays: number;
  autoDismissEnabled: boolean;
  autoDismissSeconds: number;
}
export interface AttachmentSettingsRecord {
  /** base64 附件超过该大小时不复制进 dataRoot/attachments，默认 20MB。 */
  maxStoredInlineFileMb: number;
}
export type McpServerTransportRecord =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string; headers?: Record<string, string> };
export interface McpServerConfigRecord {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpServerTransportRecord;
  createdAt: number;
  updatedAt: number;
}
export interface McpServersSettingsRecord {
  servers: McpServerConfigRecord[];
}
export type McpToolSourceStatus = 'disabled' | 'idle' | 'connecting' | 'connected' | 'error';
export interface McpToolSourceRecord {
  id: string;
  name: string;
  transportKind: McpServerTransportRecord['kind'];
  enabled: boolean;
  status: McpToolSourceStatus;
  toolCount: number;
  lastError?: string;
  updatedAt: number;
}
export interface AppearanceSettingsRecord {
  /** AI 等待响应时显示的文字（流式中但还没有任何内容块时）。 */
  streamingTextWaiting: string;
  /** AI 思考中显示的文字（思考内容正在流式输出时）。 */
  streamingTextThinking: string;
  /** AI 输出正文时显示的文字（正文正在流式输出时）。 */
  streamingTextWriting: string;
}
export type GlobalSettingsSectionValue = GlobalSettingsRecord | LlmSettingsRecord | LlmProviderConfigsRecord | LlmCompressionSettingsRecord | LlmCompressionConfigsRecord | CheckpointMaintenanceSettingsRecord | AppearanceSettingsRecord | AttachmentSettingsRecord | McpServersSettingsRecord;
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
  refreshMcpTools?: boolean;
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

export interface SkillCatalogRefreshPayload {
  reason?: string;
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

export interface AttachmentOpenPayload {
  attachmentId?: string;
  sourcePath?: string;
  mimeType?: string;
  name?: string;
}

export type AttachmentReloadPayload = AttachmentOpenPayload;

export interface AttachmentReloadResultPayload {
  request: AttachmentReloadPayload;
  part?: InlineDataPart;
  status: AttachmentAvailabilityStatus;
  error?: string;
}

export type WebviewToExtensionMessage =
  | BridgeEnvelope<BridgeMessageType.Ready, undefined>
  | BridgeEnvelope<BridgeMessageType.Ack, BridgeAckPayload>
  | BridgeEnvelope<BridgeMessageType.Ping, { text: string; sentAt: number }>
  | BridgeEnvelope<BridgeMessageType.GetWorkspaceInfo, undefined>
  | BridgeEnvelope<BridgeMessageType.ShowInfo, { message: string }>
  | BridgeEnvelope<BridgeMessageType.ChatSend, ChatSendPayload>
  | BridgeEnvelope<BridgeMessageType.ChatAbort, ChatAbortPayload>
  | BridgeEnvelope<BridgeMessageType.LlmRetryCancel, LlmRetryCancelPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationOpen, ConversationOpenPayload>
  | BridgeEnvelope<BridgeMessageType.AgentCreate, AgentCreatePayload>
  | BridgeEnvelope<BridgeMessageType.AgentUpdate, AgentUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.AgentDelete, AgentDeletePayload>
  | BridgeEnvelope<BridgeMessageType.ConversationAgentSelect, ConversationAgentSelectPayload>
  | BridgeEnvelope<BridgeMessageType.SystemPromptScopeSet, SystemPromptScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.SystemPromptScopeClear, SystemPromptScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.RuntimeContextScopeSet, RuntimeContextScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.RuntimeContextScopeClear, RuntimeContextScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.RuntimeContextRefresh, RuntimeContextRefreshPayload>
  | BridgeEnvelope<BridgeMessageType.RuntimeContextSnapshotClear, RuntimeContextSnapshotClearPayload>
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
  | BridgeEnvelope<BridgeMessageType.QueuePromote, QueuePromotePayload>
  | BridgeEnvelope<BridgeMessageType.QueueRemove, QueueRemovePayload>
  | BridgeEnvelope<BridgeMessageType.QueueReorder, QueueReorderPayload>
  | BridgeEnvelope<BridgeMessageType.QueuePause, QueuePausePayload>
  | BridgeEnvelope<BridgeMessageType.QueueResume, QueueResumePayload>
  | BridgeEnvelope<BridgeMessageType.QueueResumeAll, QueueResumeAllPayload>
  | BridgeEnvelope<BridgeMessageType.QueueInputUpdate, QueueInputUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.ToolPolicyScopeSet, ToolPolicyScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.ToolPolicyScopeClear, ToolPolicyScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.SkillPolicyScopeSet, SkillPolicyScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.SkillPolicyScopeClear, SkillPolicyScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.SkillCatalogRefresh, SkillCatalogRefreshPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointPolicyScopeSet, CheckpointPolicyScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointPolicyScopeClear, CheckpointPolicyScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.ToolExecutionApprove, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ToolExecutionReject, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ToolChangeApply, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ToolChangeReject, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ToolResultSubmit, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ToolResultReject, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointDiffOpen, CheckpointDiffOpenPayload>
  | BridgeEnvelope<BridgeMessageType.AttachmentOpen, AttachmentOpenPayload>
  | BridgeEnvelope<BridgeMessageType.AttachmentReload, AttachmentReloadPayload>
  | BridgeEnvelope<BridgeMessageType.EditToolStatisticsGet, undefined>
  | BridgeEnvelope<BridgeMessageType.ClientResync, ClientResyncPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationTimelinePageGet, ConversationTimelinePageRequest>
  | BridgeEnvelope<BridgeMessageType.RunHistoryPageGet, ConversationRunHistoryPageRequest>
  | BridgeEnvelope<BridgeMessageType.RunHistoryDetailGet, ConversationRunDetailRequest>
  | BridgeEnvelope<BridgeMessageType.LlmDryRunGet, LlmDryRunGetPayload>
  | BridgeEnvelope<BridgeMessageType.LlmProviderModelsGet, LlmProviderModelsGetPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointGitStatusGet, undefined>
  | BridgeEnvelope<BridgeMessageType.CheckpointShadowStatsGet, undefined>
  | BridgeEnvelope<BridgeMessageType.CheckpointShadowDelete, CheckpointShadowDeletePayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointDismiss, CheckpointDismissPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointRestore, CheckpointRestorePayload>
  | BridgeEnvelope<BridgeMessageType.CompressionCreate, CompressionCreatePayload>
  | BridgeEnvelope<BridgeMessageType.CompressionDelete, CompressionDeletePayload>
  | BridgeEnvelope<BridgeMessageType.CompressionUpdate, CompressionUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.CompressionRegenerate, CompressionRegeneratePayload>
  | BridgeEnvelope<BridgeMessageType.CompressionDisable, CompressionTogglePayload>
  | BridgeEnvelope<BridgeMessageType.CompressionEnable, CompressionTogglePayload>
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
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentPolicyScopeClear, WorkEnvironmentPolicyScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.FsStatGet, FsStatGetPayload>;

export type ExtensionToWebviewMessage =
  | BridgeEnvelope<BridgeMessageType.Hello, BridgeHelloPayload>
  | BridgeEnvelope<BridgeMessageType.Pong, { text: string; receivedAt: number }>
  | BridgeEnvelope<BridgeMessageType.WorkspaceInfo, WorkspaceInfo>
  | BridgeEnvelope<BridgeMessageType.Error, { requestType?: string; message: string }>
  | BridgeEnvelope<BridgeMessageType.ClientSnapshot, ClientSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ClientPatch, ClientPatchPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationTimelinePageSnapshot, ConversationTimelinePageRecord>
  | BridgeEnvelope<BridgeMessageType.ConversationTimelinePatch, ConversationTimelinePatchPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationTimelineMetaSnapshot, ConversationTimelinePageRecord>
  | BridgeEnvelope<BridgeMessageType.RunHistoryPageSnapshot, ConversationRunHistoryPageRecord>
  | BridgeEnvelope<BridgeMessageType.RunHistoryDetailSnapshot, ConversationRunDetailRecord>
  | BridgeEnvelope<BridgeMessageType.LlmDryRunSnapshot, LlmDryRunSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.LlmTransientNotice, LlmTransientNoticePayload>
  | BridgeEnvelope<BridgeMessageType.LlmProviderModelsSnapshot, LlmProviderModelsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointGitStatusSnapshot, CheckpointGitStatusSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointShadowStatsSnapshot, CheckpointShadowStatsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointRestoreResult, CheckpointRestoreResultPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointDiffOpenResult, CheckpointDiffOpenResultPayload>
  | BridgeEnvelope<BridgeMessageType.AttachmentReloadResult, AttachmentReloadResultPayload>
  | BridgeEnvelope<BridgeMessageType.EditToolStatisticsSnapshot, EditToolStatisticsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsSnapshot, GlobalSettingsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsSnapshot, ConversationSettingsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ProjectFoldersSnapshot, ProjectFoldersSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.FsStatResult, FsStatResultPayload>;

export function createMessageId(): MessageId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
