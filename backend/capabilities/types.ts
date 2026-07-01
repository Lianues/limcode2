import type * as vscode from 'vscode';
import type { LlmCompactRequest, LlmDryRunOptions, LlmDryRunResult, LlmResolveInvocationRequest, LlmStartRequest } from '../world/modules/llm/contracts';
import type { WorldEvent } from '../ecs/types';
import type {
  BridgeClientId,
  ClientState,
  ConversationHistoryPageRecord,
  ConversationHistoryPageRequest,
  ConversationRunDetailRecord,
  ConversationRunDetailRequest,
  ConversationRunHistoryPageRecord,
  ConversationRunHistoryPageRequest,
  ConversationTimelinePageRecord,
  ConversationTimelinePageRequest,
  ConversationSettingsSection,
  ConversationSettingsSectionValue,
  ExtensionToWebviewMessage,
  GlobalSettingsSection,
  GlobalSettingsSectionValue,
  EditToolMode,
  EditToolStatisticsRecord,
  LlmCompressionConfigRecord,
  MessageRecord,
  LlmProviderConfigRecord,
  LlmProviderModelRecord,
  CheckpointRecord,
  CheckpointGitStatusRecord,
  CheckpointRestorePayload,
  ShadowCheckpointRestoreResult,
  ShadowRepositoryDiskStatRecord,
  CheckpointPolicyRecord,
  CheckpointTriggerKind,
  ToolCallEventRecord,
  ToolCallRecord,
  SkillDefinitionRecord,
  SkillSource,
  RuleFileRecord,
  RuleScope,
  WebviewClientMeta,
  WorkEnvironmentRecord
} from '../../shared/protocol';
import type { TimelineProjectionContextRecord } from '../../shared/timelineProjection';

export type Emit = (event: WorldEvent) => void;

/** LLM 能力：无状态函数根据 request 启动流式执行，并通过 emit 回灌事件。 */
export interface LlmCapability {
  resolveInvocation(request: LlmResolveInvocationRequest, emit: Emit): void;
  start(request: LlmStartRequest, emit: Emit): void;
  compact(request: LlmCompactRequest, emit: Emit): void;
  dryRun(request: LlmStartRequest, options?: LlmDryRunOptions): Promise<LlmDryRunResult>;
  listModels(config: LlmProviderConfigRecord): Promise<LlmProviderModelRecord[]>;
  cancelRetry(requestId: string): void;
  abort(requestId: string): void;
}

/** 文件系统能力：隐藏 vscode.workspace.fs 等外部句柄。 */
export interface FsReadLine {
  line: number;
  text: string;
}

export interface FsReadFileResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: FsReadLine[];
  content: string;
}

export interface FsReadBinaryFileResult {
  path: string;
  name: string;
  mimeType: string;
  data: string;
  sizeBytes: number;
}

export interface FsFileDiffRecord {
  format: 'unified';
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

export interface FsStructuredEditHunk {
  oldContent: string;
  newContent: string;
  startLine?: number;
}

export interface FsInsertEditRequest {
  line: number;
  content: string;
}

export interface FsDeleteEditRequest {
  startLine: number;
  endLine: number;
}

export interface FsEditFileRequest {
  path: string;
  mode: EditToolMode;
  patch?: string;
  hunks?: FsStructuredEditHunk[];
  insert?: FsInsertEditRequest;
  delete?: FsDeleteEditRequest;
}

export type FsFileWriteAction = 'created' | 'modified' | 'unchanged' | 'deleted';

export interface FsFileChangeRecord {
  path: string;
  action: FsFileWriteAction;
  added: number;
  removed: number;
  diff?: FsFileDiffRecord;
}

export interface FsWriteFileResult {
  kind: 'file_write.result';
  path: string;
  success: boolean;
  action: FsFileWriteAction;
  summary: string;
  changedFiles: string[];
  files: FsFileChangeRecord[];
}

export type FsDeletePathTargetType = 'file' | 'directory';

export interface FsDeletePathResult {
  inputPath: string;
  path: string;
  targetType: FsDeletePathTargetType;
}

export interface FsEditFileResult {
  kind: 'file_edit.result';
  mode: EditToolMode;
  path: string;
  success: boolean;
  action: Extract<FsFileWriteAction, 'modified' | 'unchanged'>;
  totalHunks: number;
  applied: number;
  failed: number;
  fallbackMode?: string;
  results: unknown[];
  summary: string;
  changedFiles: string[];
  files: FsFileChangeRecord[];
}

export interface FsCapability {
  readFile(path: string, startLine?: number, endLine?: number, options?: WorkEnvironmentCapabilityOptions): Promise<FsReadFileResult>;
  readBinaryFile(path: string, mimeType: string, options?: WorkEnvironmentCapabilityOptions): Promise<FsReadBinaryFileResult>;
  writeFile(path: string, content: string, options?: WorkEnvironmentCapabilityOptions): Promise<FsWriteFileResult>;
  editFile(request: FsEditFileRequest, options?: WorkEnvironmentCapabilityOptions): Promise<FsEditFileResult>;
  deletePath(path: string, options?: WorkEnvironmentCapabilityOptions): Promise<FsDeletePathResult>;
}

export interface WorkEnvironmentCapabilityOptions {
  workEnvironment?: WorkEnvironmentRecord;
  allowOutsideProjectPaths?: boolean;
}

/**
 * 技能目录扫描能力。
 * 从项目 <projectRoot>/.agents/skills/ 与数据根 <dataRoot>/skills/ 扫描 SKILL.md，
 * 产出 SkillDefinitionRecord 列表；skills 工具执行时按 id/name 读取正文。
 */
export interface SkillCatalogCapability {
  list(): SkillDefinitionRecord[];
  get(name: string, source?: SkillSource): SkillDefinitionRecord | undefined;
  readBody(name: string, source?: SkillSource): Promise<string>;
  refresh(): Promise<void>;
}

/**
 * 规则文件扫描能力。
 * 从项目根 <projectRoot>/{AGENTS,CLAUDE}.md 与数据根 <dataRoot>/{AGENTS,CLAUDE}.md 读取规则，
 * 产出 RuleFileRecord 列表；AGENTS.md 可写回，CLAUDE.md 只读兼容。
 */
export interface RulesCatalogCapability {
  list(): RuleFileRecord[];
  writeAgents(scope: RuleScope, content: string): Promise<void>;
  refresh(): Promise<void>;
}

export interface CommandRunEvent {
  kind: 'stdout' | 'stderr' | 'progress';
  delta?: string;
  payload?: unknown;
}

export interface CommandRunObserver {
  onEvent?: (event: CommandRunEvent) => void;
}

export interface CommandRunArgs {
  command?: string;
  cwd?: string;
  timeout?: number;
}

/** 返回给模型的 stdout/stderr 输出上限（保留末尾内容）。 */
export interface CommandOutputLimits {
  maxOutputLines: number;
  maxOutputChars: number;
}

/**
 * 命令执行/后台进程状态：
 * - completed：前台同步执行完毕。
 * - running：超时转入后台，进程仍在运行。
 * - exited：后台进程已自然退出（通过 output 读到）。
 * - killed：后台进程被 kill 终止。
 * - not_found：output/kill 指定的 processId 不存在（已清理或从未存在）。
 */
export type CommandRunStatus = 'completed' | 'running' | 'exited' | 'killed' | 'not_found';

export interface CommandRunResult {
  command: string;
  exitCode: number;
  killed: boolean;
  stdout: string;
  stderr: string;
  /** 执行/后台状态；旧调用方（如远程分支）可不填。 */
  status?: CommandRunStatus;
  /** 转入后台或针对后台进程操作时的进程 id。 */
  processId?: string;
  /** output 模式：进程当前是否仍在运行。 */
  running?: boolean;
  /** 因后台 buffer 上限被丢弃的字符数（>0 时提示模型有更早输出被截断）。 */
  droppedChars?: number;
}

export type WorkEnvironmentTransferKind = 'auto' | 'file' | 'directory';
export type WorkEnvironmentTransferVerifyMode = 'none' | 'size';

export interface WorkEnvironmentTransferItem {
  fromEnvironment: string;
  fromPath: string;
  toEnvironment: string;
  toPath: string;
  type?: WorkEnvironmentTransferKind;
  overwrite?: boolean;
  createDirs?: boolean;
}

export interface WorkEnvironmentTransferArgs {
  transfers?: WorkEnvironmentTransferItem[];
  verify?: WorkEnvironmentTransferVerifyMode;
}

export interface WorkEnvironmentTransferContext {
  activeWorkEnvironment?: WorkEnvironmentRecord;
  availableWorkEnvironments?: WorkEnvironmentRecord[];
  allowOutsideProjectPaths?: boolean;
}

export interface WorkEnvironmentTransferEntryResult {
  success: boolean;
  index: number;
  type: WorkEnvironmentTransferKind;
  from: { environment: string; path: string };
  to: { environment: string; path: string };
  files?: number;
  dirs?: number;
  bytes?: number;
  verify?: { mode: WorkEnvironmentTransferVerifyMode; ok: boolean };
  error?: string;
  durationMs: number;
}

export interface WorkEnvironmentTransferResult {
  results: WorkEnvironmentTransferEntryResult[];
  successCount: number;
  failCount: number;
  totalCount: number;
}

export interface WorkEnvironmentRuntimeCapability {
  transferFiles(
    args: WorkEnvironmentTransferArgs,
    observer?: CommandRunObserver,
    context?: WorkEnvironmentTransferContext
  ): Promise<WorkEnvironmentTransferResult>;
}

/** 命令执行能力：根据 extension host 平台自动选择 PowerShell(shell) 或 Bash(bash)。 */
export interface CommandCapability {
  readonly toolName: 'shell' | 'bash';
  readonly description: string;
  /** 执行新命令；超时不再 kill，而是转入后台并返回 { status:'running', processId }。limits 控制返回给模型的输出上限。 */
  run(args: CommandRunArgs, observer?: CommandRunObserver, options?: WorkEnvironmentCapabilityOptions, limits?: CommandOutputLimits): Promise<CommandRunResult>;
  /** 读取某后台进程当前已累积的全部日志，并返回其运行状态。 */
  readOutput(processId: string, limits: CommandOutputLimits): CommandRunResult;
  /** 终止某后台进程；终止后日志临时保留一小段时间，可用 readOutput 查看最终结果。 */
  kill(processId: string): CommandRunResult;
  /** 扩展关闭时终止所有残留后台进程并清理。 */
  dispose(): void;
}

export interface WebviewClientRuntimeRecord {
  id: BridgeClientId;
  meta: WebviewClientMeta;
  attachedAt: number;
}

/** Webview 能力：集中管理多个 Webview client，真实 vscode.Webview 句柄不进入 ECS world。 */
export interface WebviewCapability {
  attach(webview: vscode.Webview, meta?: WebviewClientMeta): BridgeClientId;
  detach(clientId: BridgeClientId): void;
  detachAll(): void;
  subscribe(clientId: BridgeClientId, streamId: string): void;
  unsubscribe(clientId: BridgeClientId, streamId: string): void;
  post(clientId: BridgeClientId, message: ExtensionToWebviewMessage): void;
  broadcast(message: ExtensionToWebviewMessage): void;
  broadcastToStream(streamId: string, message: ExtensionToWebviewMessage): void;
  clientIds(): BridgeClientId[];
  clientRecords(): WebviewClientRuntimeRecord[];
}

/** 插件数据目录：集中记录所有持久化数据的当前根位置；可由扩展级 globalState 指向自定义目录。 */
export interface RuntimePaths {
  /** 当前 active data root；未配置自定义目录时等于 VS Code context.globalStorageUri。 */
  globalStorageUri: vscode.Uri;
  globalStoragePath: string;
  /** Agent 数据根目录：<dataRoot>/agents */
  agentsRootUri: vscode.Uri;
  agentsRootPath: string;
  agentsIndexUri: vscode.Uri;
  agentsIndexPath: string;
  /** Mode 数据根目录：<dataRoot>/modes */
  modesRootUri: vscode.Uri;
  modesRootPath: string;
  modesIndexUri: vscode.Uri;
  modesIndexPath: string;
  /** ToolPolicy 数据根目录：<dataRoot>/tool-policies */
  toolPoliciesRootUri: vscode.Uri;
  toolPoliciesRootPath: string;
  toolPoliciesIndexUri: vscode.Uri;
  toolPoliciesIndexPath: string;
  /** ToolPolicy 与各作用域的关系数据根目录：<dataRoot>/tool-policy-scope-links */
  toolPolicyScopeLinksRootUri: vscode.Uri;
  toolPolicyScopeLinksRootPath: string;
  toolPolicyScopeLinksIndexUri: vscode.Uri;
  toolPolicyScopeLinksIndexPath: string;
  /** SkillPolicy 数据根目录：<dataRoot>/skill-policies */
  skillPoliciesRootUri: vscode.Uri;
  skillPoliciesRootPath: string;
  skillPoliciesIndexUri: vscode.Uri;
  skillPoliciesIndexPath: string;
  /** SkillPolicy 与各作用域的关系数据根目录：<dataRoot>/skill-policy-scope-links */
  skillPolicyScopeLinksRootUri: vscode.Uri;
  skillPolicyScopeLinksRootPath: string;
  skillPolicyScopeLinksIndexUri: vscode.Uri;
  skillPolicyScopeLinksIndexPath: string;
  /** SystemPrompt 数据根目录：<dataRoot>/system-prompts */
  systemPromptsRootUri: vscode.Uri;
  systemPromptsRootPath: string;
  systemPromptsIndexUri: vscode.Uri;
  systemPromptsIndexPath: string;
  /** RuntimeContext 模板数据根目录：<dataRoot>/runtime-contexts */
  runtimeContextsRootUri: vscode.Uri;
  runtimeContextsRootPath: string;
  runtimeContextsIndexUri: vscode.Uri;
  runtimeContextsIndexPath: string;
  /** RuntimeContext 与各 scope 的关系数据根目录：<dataRoot>/runtime-context-scope-links */
  runtimeContextScopeLinksRootUri: vscode.Uri;
  runtimeContextScopeLinksRootPath: string;
  runtimeContextScopeLinksIndexUri: vscode.Uri;
  runtimeContextScopeLinksIndexPath: string;
  /** RuntimeContext 快照数据根目录：<dataRoot>/runtime-context-snapshots */
  runtimeContextSnapshotsRootUri: vscode.Uri;
  runtimeContextSnapshotsRootPath: string;
  runtimeContextSnapshotsIndexUri: vscode.Uri;
  runtimeContextSnapshotsIndexPath: string;
  /** Conversation 与 RuntimeContextSnapshot 的关系数据根目录：<dataRoot>/conversation-runtime-context-snapshot-links */
  conversationRuntimeContextSnapshotLinksRootUri: vscode.Uri;
  conversationRuntimeContextSnapshotLinksRootPath: string;
  conversationRuntimeContextSnapshotLinksIndexUri: vscode.Uri;
  conversationRuntimeContextSnapshotLinksIndexPath: string;
  /** Run 与 RuntimeContextSnapshot 的关系数据根目录：<dataRoot>/run-runtime-context-snapshot-links */
  runRuntimeContextSnapshotLinksRootUri: vscode.Uri;
  runRuntimeContextSnapshotLinksRootPath: string;
  runRuntimeContextSnapshotLinksIndexUri: vscode.Uri;
  runRuntimeContextSnapshotLinksIndexPath: string;
  /** ModelProfile 数据根目录：<dataRoot>/model-profiles */
  modelProfilesRootUri: vscode.Uri;
  modelProfilesRootPath: string;
  modelProfilesIndexUri: vscode.Uri;
  modelProfilesIndexPath: string;
  /** SystemPrompt 与各 scope 的关系数据根目录：<dataRoot>/system-prompt-scope-links */
  systemPromptScopeLinksRootUri: vscode.Uri;
  systemPromptScopeLinksRootPath: string;
  systemPromptScopeLinksIndexUri: vscode.Uri;
  systemPromptScopeLinksIndexPath: string;
  /** ModelProfile 与各 scope 的关系数据根目录：<dataRoot>/model-profile-scope-links */
  modelProfileScopeLinksRootUri: vscode.Uri;
  modelProfileScopeLinksRootPath: string;
  modelProfileScopeLinksIndexUri: vscode.Uri;
  modelProfileScopeLinksIndexPath: string;
  /** Conversation/消息数据根目录：<dataRoot>/conversations */
  conversationsRootUri: vscode.Uri;
  conversationsRootPath: string;
  conversationsIndexUri: vscode.Uri;
  conversationsIndexPath: string;
  /** 侧边栏历史列表读模型根目录：<dataRoot>/conversation-history */
  conversationHistoryRootUri: vscode.Uri;
  conversationHistoryRootPath: string;
  conversationHistoryIndexUri: vscode.Uri;
  conversationHistoryIndexPath: string;
  /** 多模态小附件数据根目录：<dataRoot>/attachments */
  attachmentsRootUri: vscode.Uri;
  attachmentsRootPath: string;
  attachmentsIndexUri: vscode.Uri;
  attachmentsIndexPath: string;
  /** 项目路径上下文数据根目录：<dataRoot>/project-contexts */
  projectContextsRootUri: vscode.Uri;
  projectContextsRootPath: string;
  projectContextsIndexUri: vscode.Uri;
  projectContextsIndexPath: string;
  /** Conversation 与项目路径的关系数据根目录：<dataRoot>/conversation-project-links */
  conversationProjectLinksRootUri: vscode.Uri;
  conversationProjectLinksRootPath: string;
  conversationProjectLinksIndexUri: vscode.Uri;
  conversationProjectLinksIndexPath: string;
  /** 工作环境数据根目录：<dataRoot>/work-environments */
  workEnvironmentsRootUri: vscode.Uri;
  workEnvironmentsRootPath: string;
  workEnvironmentsIndexUri: vscode.Uri;
  workEnvironmentsIndexPath: string;
  /** 工作环境策略数据根目录：<dataRoot>/work-environment-policies */
  workEnvironmentPoliciesRootUri: vscode.Uri;
  workEnvironmentPoliciesRootPath: string;
  workEnvironmentPoliciesIndexUri: vscode.Uri;
  workEnvironmentPoliciesIndexPath: string;
  workEnvironmentPolicyScopeLinksRootUri: vscode.Uri;
  workEnvironmentPolicyScopeLinksRootPath: string;
  workEnvironmentPolicyScopeLinksIndexUri: vscode.Uri;
  workEnvironmentPolicyScopeLinksIndexPath: string;
  /** Conversation 与工作环境的关系数据根目录：<dataRoot>/conversation-work-environment-links */
  conversationWorkEnvironmentLinksRootUri: vscode.Uri;
  conversationWorkEnvironmentLinksRootPath: string;
  conversationWorkEnvironmentLinksIndexUri: vscode.Uri;
  conversationWorkEnvironmentLinksIndexPath: string;
  /** AgentRun 与工作环境的关系数据根目录：<dataRoot>/run-work-environment-links */
  runWorkEnvironmentLinksRootUri: vscode.Uri;
  runWorkEnvironmentLinksRootPath: string;
  runWorkEnvironmentLinksIndexUri: vscode.Uri;
  runWorkEnvironmentLinksIndexPath: string;
  checkpointPoliciesRootUri: vscode.Uri;
  checkpointPoliciesRootPath: string;
  checkpointPoliciesIndexUri: vscode.Uri;
  checkpointPoliciesIndexPath: string;
  checkpointPolicyScopeLinksRootUri: vscode.Uri;
  checkpointPolicyScopeLinksRootPath: string;
  checkpointPolicyScopeLinksIndexUri: vscode.Uri;
  checkpointPolicyScopeLinksIndexPath: string;
  shadowRepositoriesRootUri: vscode.Uri;
  shadowRepositoriesRootPath: string;
  shadowRepositoriesIndexUri: vscode.Uri;
  shadowRepositoriesIndexPath: string;
  conversationCheckpointRepositoryLinksRootUri: vscode.Uri;
  conversationCheckpointRepositoryLinksRootPath: string;
  conversationCheckpointRepositoryLinksIndexUri: vscode.Uri;
  conversationCheckpointRepositoryLinksIndexPath: string;
  checkpointsRootUri: vscode.Uri;
  checkpointsRootPath: string;
  checkpointsIndexUri: vscode.Uri;
  checkpointsIndexPath: string;
  checkpointTimelineAnchorsRootUri: vscode.Uri;
  checkpointTimelineAnchorsRootPath: string;
  checkpointTimelineAnchorsIndexUri: vscode.Uri;
  checkpointTimelineAnchorsIndexPath: string;
  checkpointShadowWorktreesRootUri: vscode.Uri;
  checkpointShadowWorktreesRootPath: string;
  compressionBlocksRootUri: vscode.Uri;
  compressionBlocksRootPath: string;
  compressionBlocksIndexUri: vscode.Uri;
  compressionBlocksIndexPath: string;
  compressionBlockSourceLinksRootUri: vscode.Uri;
  compressionBlockSourceLinksRootPath: string;
  compressionBlockSourceLinksIndexUri: vscode.Uri;
  compressionBlockSourceLinksIndexPath: string;
  compressionContextVariantsRootUri: vscode.Uri;
  compressionContextVariantsRootPath: string;
  compressionContextVariantsIndexUri: vscode.Uri;
  compressionContextVariantsIndexPath: string;
  compressionBlockLlmInvocationLinksRootUri: vscode.Uri;
  compressionBlockLlmInvocationLinksRootPath: string;
  compressionBlockLlmInvocationLinksIndexUri: vscode.Uri;
  compressionBlockLlmInvocationLinksIndexPath: string;

  compressionLlmInvocationsRootUri: vscode.Uri;
  compressionLlmInvocationsRootPath: string;
  compressionLlmInvocationsIndexUri: vscode.Uri;
  compressionLlmInvocationsIndexPath: string;

  /** Agent 与 Conversation 的关系数据根目录：<dataRoot>/agent-conversation-links */
  linksRootUri: vscode.Uri;
  linksRootPath: string;
  linksIndexUri: vscode.Uri;
  linksIndexPath: string;
  /** Conversation 的当前模式选择数据根目录：<dataRoot>/conversation-mode-selections */
  conversationModeSelectionsRootUri: vscode.Uri;
  conversationModeSelectionsRootPath: string;
  conversationModeSelectionsIndexUri: vscode.Uri;
  conversationModeSelectionsIndexPath: string;
  /** Conversation 的当前 Agent 选择数据根目录：<dataRoot>/conversation-agent-selections */
  conversationAgentSelectionsRootUri: vscode.Uri;
  conversationAgentSelectionsRootPath: string;
  conversationAgentSelectionsIndexUri: vscode.Uri;
  conversationAgentSelectionsIndexPath: string;
  runHistoryRootUri: vscode.Uri;
  runHistoryRootPath: string;
  runHistoryIndexUri: vscode.Uri;
  runHistoryIndexPath: string;
  /** Agent 回答数据根目录：<dataRoot>/agent-answers */
  agentAnswersRootUri: vscode.Uri;
  agentAnswersRootPath: string;
  agentAnswersIndexUri: vscode.Uri;
  agentAnswersIndexPath: string;
  /** Agent 回答提交来源关系数据根目录：<dataRoot>/agent-answer-submission-links */
  agentAnswerSubmissionLinksRootUri: vscode.Uri;
  agentAnswerSubmissionLinksRootPath: string;
  agentAnswerSubmissionLinksIndexUri: vscode.Uri;
  agentAnswerSubmissionLinksIndexPath: string;
  /** Agent 回答目标关系数据根目录：<dataRoot>/agent-answer-target-links */
  agentAnswerTargetLinksRootUri: vscode.Uri;
  agentAnswerTargetLinksRootPath: string;
  agentAnswerTargetLinksIndexUri: vscode.Uri;
  agentAnswerTargetLinksIndexPath: string;

  /** 通用设置根目录：<dataRoot>/settings */
  settingsRootUri: vscode.Uri;
  settingsRootPath: string;
  /** LLM 设置文件：<dataRoot>/settings/llm.json */
  llmSettingsUri: vscode.Uri;
  llmSettingsPath: string;
}

/** VS Code 存储能力：通过 workspace.fs/globalState 读写插件全局数据。 */
export type ConversationRunHistorySaveMode = 'merge' | 'replace';

export interface StorageCapability {
  /** 当前 active data root 派生出的路径；数据目录切换后 getter 会返回新路径。 */
  readonly paths: RuntimePaths;
  ensureReady(): Promise<void>;
  loadClientStateSkeleton(options?: { profile?: 'startup' | 'deferred' | 'full' }): Promise<ClientState | undefined>;
  loadConversationDetail(
    conversationId: string,
    options?: { includeRunHistory?: boolean }
  ): Promise<ClientState | undefined>;
  loadConversationTimelineProjectionContext(
    conversationId: string,
    projectionKey: string,
    chunkId?: string
  ): Promise<TimelineProjectionContextRecord | undefined>;
  loadConversationTimelinePage(request: ConversationTimelinePageRequest): Promise<ConversationTimelinePageRecord>;
  loadConversationLatestMessages(conversationId: string, limit?: number): Promise<MessageRecord[]>;
  loadConversationMessagesByIds(conversationId: string, messageIds: readonly string[]): Promise<MessageRecord[]>;
  loadConversationTimelineRange(request: {
    conversationId: string;
    mode: 'suffix' | 'prefix' | 'between';
    anchorMessageId?: string;
    startMessageId?: string;
    endMessageId?: string;
    contextBeforeChunks?: number;
  }): Promise<ClientState | undefined>;
  saveClientStateSkeleton(state: ClientState): Promise<void>;
  saveConversationRenderDetail(conversationId: string, state: ClientState): Promise<void>;
  saveConversationRunHistory(conversationId: string, state: ClientState, options: { mode: ConversationRunHistorySaveMode }): Promise<void>;
  loadConversationRunHistoryPage(request: ConversationRunHistoryPageRequest): Promise<ConversationRunHistoryPageRecord>;
  loadConversationRunDetail(request: ConversationRunDetailRequest): Promise<ConversationRunDetailRecord | undefined>;
  resolveConversationRunIdForMessage(conversationId: string, messageId: string): Promise<string | undefined>;
  loadConversationHistoryPage(request: ConversationHistoryPageRequest): Promise<ConversationHistoryPageRecord>;
  upsertConversationHistoryEntry(entry: import('../../shared/protocol').SidebarConversationHistoryEntry): Promise<void>;
  removeConversationHistoryEntry(conversationId: string): Promise<void>;
  saveMessageSnapshot(conversationId: string, message: import('../../shared/protocol').MessageRecord): Promise<void>;
  removeMessage(conversationId: string, messageId: string): Promise<void>;
  saveToolCallSnapshot(conversationId: string, toolCall: ToolCallRecord): Promise<void>;
  appendToolCallEvent(conversationId: string, event: ToolCallEventRecord): Promise<void>;
  detectSystemGit(): Promise<CheckpointGitStatusRecord>;
  createShadowCheckpoint(request: ShadowCheckpointCreateRequest): Promise<CheckpointRecord>;
  restoreShadowCheckpoint(request: CheckpointRestorePayload): Promise<ShadowCheckpointRestoreResult>;
  openShadowCheckpointDiff(request: ShadowCheckpointDiffOpenRequest): Promise<ShadowCheckpointDiffOpenResult>;
  loadEditToolStatistics(): Promise<EditToolStatisticsRecord>;
  recordEditToolModeResult(mode: EditToolMode, success: boolean): Promise<EditToolStatisticsRecord>;
  collectShadowWorktreeStats(): Promise<ShadowRepositoryDiskStatRecord[]>;
  deleteShadowWorktrees(storageKeys: string[]): Promise<{ deletedStorageKeys: string[] }>;
  cleanupUnusedShadowWorktrees(maxAgeDays: number): Promise<{ deletedStorageKeys: string[] }>;
  loadGlobalSettings(section: GlobalSettingsSection): Promise<{ section: GlobalSettingsSection; settings: GlobalSettingsSectionValue; filePath: string }>;
  saveGlobalSettings(section: GlobalSettingsSection, settings: GlobalSettingsSectionValue): Promise<{ section: GlobalSettingsSection; settings: GlobalSettingsSectionValue; filePath: string }>;
  loadActiveLlmProviderConfig(conversationId?: string): Promise<LlmProviderConfigRecord>;
  loadLlmProviderConfigById(configId: string): Promise<LlmProviderConfigRecord | undefined>;
  loadActiveLlmCompressionConfig(providerConfigId?: string): Promise<LlmCompressionConfigRecord | undefined>;
  loadLlmCompressionConfigById(configId: string): Promise<LlmCompressionConfigRecord | undefined>;
  loadConversationSettings(conversationId: string, section: ConversationSettingsSection): Promise<{ conversationId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string } | undefined>;
  saveConversationSettings(section: ConversationSettingsSection, settings: ConversationSettingsSectionValue): Promise<{ conversationId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string }>;
}

export interface ShadowCheckpointCreateRequest {
  checkpointId: string;
  conversationId: string;
  projectContextId: string;
  projectUri: string;
  projectDisplayPath: string;
  shadowRepositoryId: string;
  shadowRepositoryStorageKey: string;
  trigger: CheckpointTriggerKind;
  policy: CheckpointPolicyRecord;
}

export interface ShadowCheckpointDiffOpenRequest {
  checkpointId: string;
  conversationId: string;
  shadowRepositoryStorageKey: string;
  commitSha: string;
  projectUri: string;
  filePath: string;
}

export interface ShadowCheckpointDiffOpenResult {
  status: 'opened' | 'failed';
  message: string;
}
