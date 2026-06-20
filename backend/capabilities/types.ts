import type * as vscode from 'vscode';
import type { LlmDryRunOptions, LlmDryRunResult, LlmStartRequest } from '../world/modules/llm/contracts';
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
  ConversationSettingsSection,
  ConversationSettingsSectionValue,
  ExtensionToWebviewMessage,
  GlobalSettingsSection,
  GlobalSettingsSectionValue,
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
  WebviewClientMeta,
  WorkEnvironmentRecord
} from '../../shared/protocol';
import type { TimelineProjectionContextRecord } from '../../shared/timelineProjection';

export type Emit = (event: WorldEvent) => void;

/** LLM 能力：无状态函数根据 request 启动流式执行，并通过 emit 回灌事件。 */
export interface LlmCapability {
  start(request: LlmStartRequest, emit: Emit): void;
  dryRun(request: LlmStartRequest, options?: LlmDryRunOptions): Promise<LlmDryRunResult>;
  listModels(config: LlmProviderConfigRecord): Promise<LlmProviderModelRecord[]>;
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

export interface FsCapability {
  readFile(path: string, startLine?: number, endLine?: number, options?: WorkEnvironmentCapabilityOptions): Promise<FsReadFileResult>;
}

export interface WorkEnvironmentCapabilityOptions {
  workEnvironment?: WorkEnvironmentRecord;
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
  force?: boolean;
}

export interface CommandRunResult {
  command: string;
  exitCode: number;
  killed: boolean;
  stdout: string;
  stderr: string;
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
  run(args: CommandRunArgs, observer?: CommandRunObserver, options?: WorkEnvironmentCapabilityOptions): Promise<CommandRunResult>;
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
  /** SystemPrompt 数据根目录：<dataRoot>/system-prompts */
  systemPromptsRootUri: vscode.Uri;
  systemPromptsRootPath: string;
  systemPromptsIndexUri: vscode.Uri;
  systemPromptsIndexPath: string;
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
  collectShadowWorktreeStats(): Promise<ShadowRepositoryDiskStatRecord[]>;
  deleteShadowWorktrees(storageKeys: string[]): Promise<{ deletedStorageKeys: string[] }>;
  cleanupUnusedShadowWorktrees(maxAgeDays: number): Promise<{ deletedStorageKeys: string[] }>;
  loadGlobalSettings(section: GlobalSettingsSection): Promise<{ section: GlobalSettingsSection; settings: GlobalSettingsSectionValue; filePath: string }>;
  saveGlobalSettings(section: GlobalSettingsSection, settings: GlobalSettingsSectionValue): Promise<{ section: GlobalSettingsSection; settings: GlobalSettingsSectionValue; filePath: string }>;
  loadActiveLlmProviderConfig(conversationId?: string): Promise<LlmProviderConfigRecord>;
  loadLlmProviderConfigById(configId: string): Promise<LlmProviderConfigRecord | undefined>;
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
