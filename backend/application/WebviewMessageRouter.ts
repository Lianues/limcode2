import * as vscode from 'vscode';
import type { World } from '../ecs/types';
import type { LlmCapability, StorageCapability, WebviewCapability } from '../capabilities/types';
import { ChatEventType } from '../world/modules/chat/events';
import { AgentRunEventType } from '../world/modules/agentRun/events';
import { AgentRun } from '../world/modules/agentRun/components';
import { Conversation, Message } from '../world/modules/chat/components';
import { LlmInvocation, MessageLlmInvocationLink, RunLlmInvocationLink } from '../world/modules/llm/components';
import { buildLlmStartRequestForRun } from '../world/modules/chat/systems/LlmDispatchSystem';
import { CompressionBlock, CompressionBlockLlmInvocationLink, CompressionBlockSourceLink } from '../world/modules/compression/components';
import { ToolEventType } from '../world/modules/tools/events';
import { ModeEventType } from '../world/modules/mode/events';
import { WorkEnvironmentEventType } from '../world/modules/workEnvironment/events';
import { CheckpointEventType } from '../world/modules/checkpoint/events';
import { AgentEventType } from '../world/modules/agent/events';
import { CompressionEventType } from '../world/modules/compression/events';
import { RuntimeContextEventType } from '../world/modules/runtimeContext/events';
import { Checkpoint, ShadowRepository } from '../world/modules/checkpoint/components';
import {
  BridgeMessageType,
  GLOBAL_CLIENT_STATE_STREAM_ID,
  GLOBAL_SETTINGS_SECTIONS,
  conversationClientStateStreamId,
  conversationIdFromClientStateStreamId,
  conversationTimelineStreamId,
  conversationSettingsStreamId,
  globalSettingsStreamId,
  createMessageId,
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isProviderContextPart,
  isTextPart,
  type BridgeClientId,
  type CheckpointDiffOpenPayload,
  type CheckpointRestorePayload,
  type ContentPart,
  type ConversationTimelinePageRequest,
  type LlmInvocationSettingsSnapshotRecord,
  type MessageContent,
  type LlmProviderModelsGetPayload,
  type ProjectFolderCandidateRecord,
  type WebviewToExtensionMessage
} from '../../shared/protocol';
import { hydrateConversationDetail } from './clientStateHydration';

import type { GlobalSettingsBridge } from './GlobalSettingsBridge';
import type { ConversationSettingsBridge } from './ConversationSettingsBridge';
import type { SetConversationProjectFolderInput } from './BackendApplication';
import type { WebviewClientRegistry } from './WebviewClientRegistry';

export interface WebviewMessageRouterDeps {
  world: World;
  webview: WebviewCapability;
  clients: WebviewClientRegistry;
  storage: StorageCapability;
  llm: LlmCapability;
  globalSettingsBridge: GlobalSettingsBridge;
  conversationSettingsBridge: ConversationSettingsBridge;
  isHydrated: () => boolean;
  requestSnapshot: (conversationId?: string) => void;
  ensureConversationDetailLoaded: (conversationId: string) => Promise<void>;
  getProjectFolderCandidates: () => ProjectFolderCandidateRecord[];
  setConversationProjectFolder: (input: SetConversationProjectFolderInput) => boolean;
  importWorkEnvironmentsFromVscode: () => Promise<number>;
}

/**
 * Webview -> backend 消息路由。
 * 只负责把 bridge message 分发到 chat/settings/control 等应用动作。
 */
export class WebviewMessageRouter {
  public constructor(private readonly deps: WebviewMessageRouterDeps) {}

  public handle(clientId: BridgeClientId, message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case BridgeMessageType.ChatSend:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.enqueueAfterConversationLoaded(message.payload.conversationId, () => {
          this.deps.world.enqueue({ type: ChatEventType.Send, payload: message.payload });
        });
        break;
      case BridgeMessageType.ChatAbort:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ChatEventType.Abort, payload: message.payload });
        this.deps.world.enqueue({ type: AgentRunEventType.CancelConversation, payload: { conversationId: message.payload.conversationId, reason: 'chat_abort' } });
        break;
      case BridgeMessageType.MessageEdit:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.enqueueAfterConversationLoaded(message.payload.conversationId, () => {
          this.deps.world.enqueue({ type: ChatEventType.Edit, payload: message.payload });
        });
        break;
      case BridgeMessageType.MessageDeleteFrom:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.enqueueAfterConversationLoaded(message.payload.conversationId, () => {
          this.deps.world.enqueue({ type: ChatEventType.DeleteFrom, payload: message.payload });
        });
        break;
      case BridgeMessageType.MessageRetryFrom:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.enqueueAfterConversationLoaded(message.payload.conversationId, () => {
          this.deps.world.enqueue({ type: ChatEventType.RetryFrom, payload: message.payload });
        });
        break;
      case BridgeMessageType.ToolPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ToolPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ToolExecutionApprove:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ExecutionApproveRequested, payload: message.payload });
        break;
      case BridgeMessageType.ToolExecutionReject:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ExecutionRejectRequested, payload: message.payload });
        break;
      case BridgeMessageType.ToolChangeApply:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ChangeApplyRequested, payload: message.payload });
        break;
      case BridgeMessageType.ToolChangeReject:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ChangeRejectRequested, payload: message.payload });
        break;
      case BridgeMessageType.ToolResultSubmit:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ResultSubmitRequested, payload: message.payload });
        break;
      case BridgeMessageType.ToolResultReject:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ResultRejectRequested, payload: message.payload });
        break;
      case BridgeMessageType.AgentRunCancel:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.Cancel, payload: message.payload });
        break;
      case BridgeMessageType.AgentRunPause:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.Pause, payload: message.payload });
        break;
      case BridgeMessageType.AgentRunResume:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.Resume, payload: message.payload });
        break;
      case BridgeMessageType.AgentRunRetry:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.Retry, payload: message.payload });
        break;
      case BridgeMessageType.AgentRunRegenerate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.Regenerate, payload: message.payload });
        break;
      case BridgeMessageType.AgentRunMarkStale:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.MarkStale, payload: message.payload });
        break;
      case BridgeMessageType.QueuePromote:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.Promote, payload: message.payload });
        break;
      case BridgeMessageType.QueueRemove:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.RemoveQueued, payload: message.payload });
        break;
      case BridgeMessageType.QueueReorder:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.ReorderQueue, payload: message.payload });
        break;
      case BridgeMessageType.QueuePause:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.PauseQueue, payload: message.payload });
        break;
      case BridgeMessageType.QueueResume:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.ResumeQueue, payload: message.payload });
        break;
      case BridgeMessageType.QueueResumeAll:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.ResumeQueueConversation, payload: message.payload });
        break;
      case BridgeMessageType.QueueInputUpdate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentRunEventType.UpdateQueuedInput, payload: message.payload });
        break;
      case BridgeMessageType.AgentCreate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.Create, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.AgentUpdate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.Update, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.AgentDelete:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.Delete, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ConversationAgentSelect:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.ConversationSelect, payload: message.payload });
        this.deps.requestSnapshot(message.payload.conversationId);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.SystemPromptScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.SystemPromptScopeSet, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.SystemPromptScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.SystemPromptScopeClear, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.RuntimeContextScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: RuntimeContextEventType.ScopeSet, payload: message.payload });
        this.deps.requestSnapshot(message.payload.scopeKind === 'conversation' ? message.payload.scopeId : undefined);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.RuntimeContextScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: RuntimeContextEventType.ScopeClear, payload: message.payload });
        this.deps.requestSnapshot(message.payload.scopeKind === 'conversation' ? message.payload.scopeId : undefined);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.RuntimeContextRefresh:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: RuntimeContextEventType.Refresh, payload: message.payload });
        this.deps.requestSnapshot(message.payload.conversationId ?? (message.payload.scopeKind === 'conversation' ? message.payload.scopeId : undefined));
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.RuntimeContextSnapshotClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: RuntimeContextEventType.SnapshotClear, payload: message.payload });
        this.deps.requestSnapshot(message.payload.conversationId);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ModelProfileScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.ModelProfileScopeSet, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ModelProfileScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.ModelProfileScopeClear, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ModeCreate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ModeEventType.Create, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ModeUpdate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ModeEventType.Update, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ModeDelete:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ModeEventType.Delete, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ConversationModeSelect:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ModeEventType.ConversationSelect, payload: message.payload });
        this.deps.requestSnapshot(message.payload.conversationId);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ClientResync:
        this.handleClientResync(clientId, message.payload?.streamId, message.payload?.conversationId);
        break;
      case BridgeMessageType.ConversationTimelinePageGet:
        if (message.payload) void this.postConversationTimelinePage(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.RunHistoryPageGet:
        if (message.payload) void this.postRunHistoryPage(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.RunHistoryDetailGet:
        if (message.payload) void this.postRunHistoryDetail(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.LlmDryRunGet:
        if (message.payload) void this.postLlmDryRun(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.LlmProviderModelsGet:
        if (message.payload) void this.postLlmProviderModels(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.CheckpointGitStatusGet:
        void this.postCheckpointGitStatus(clientId, message.id);
        break;
      case BridgeMessageType.CheckpointShadowStatsGet:
        void this.postCheckpointShadowStats(clientId, message.id);
        break;
      case BridgeMessageType.CheckpointShadowDelete:
        if (message.payload) void this.handleCheckpointShadowDelete(clientId, message.payload.storageKeys, message.id);
        break;
      case BridgeMessageType.EditToolStatisticsGet:
        void this.postEditToolStatistics(clientId, message.id);
        break;
      case BridgeMessageType.CompressionCreate:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.enqueueAfterConversationLoaded(message.payload.conversationId, () => {
          this.deps.world.enqueue({ type: CompressionEventType.Create, payload: message.payload });
        });
        break;
      case BridgeMessageType.CompressionDelete:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CompressionEventType.Delete, payload: message.payload });
        break;
      case BridgeMessageType.CompressionUpdate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CompressionEventType.Update, payload: message.payload });
        break;
      case BridgeMessageType.CompressionRegenerate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CompressionEventType.Regenerate, payload: message.payload });
        break;
      case BridgeMessageType.CompressionDisable:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CompressionEventType.Disable, payload: message.payload });
        break;
      case BridgeMessageType.CompressionEnable:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CompressionEventType.Enable, payload: message.payload });
        break;
      case BridgeMessageType.GlobalSettingsGet:
        if (!message.payload) return;
        this.deps.webview.subscribe(clientId, globalSettingsStreamId(message.payload.section));
        void this.deps.globalSettingsBridge.postSnapshot(clientId, message.payload.section, message.id);
        break;
      case BridgeMessageType.GlobalSettingsUpdate:
        if (!message.payload) return;
        this.deps.webview.subscribe(clientId, globalSettingsStreamId(message.payload.section));
        void this.deps.globalSettingsBridge.update(message.payload, message.id);
        break;
      case BridgeMessageType.ConversationSettingsGet:
        if (!message.payload) return;
        void this.deps.conversationSettingsBridge.postSnapshot(clientId, message.payload.conversationId, message.payload.section, message.id);
        break;
      case BridgeMessageType.ConversationSettingsUpdate:
        if (!message.payload) return;
        this.deps.webview.subscribe(clientId, conversationSettingsStreamId(message.payload.settings.conversationId ?? '', message.payload.section));
        void this.deps.conversationSettingsBridge.update(message.payload, message.id);
        break;
      case BridgeMessageType.ProjectFoldersGet:
        this.deps.webview.post(clientId, {
          id: createMessageId(),
          type: BridgeMessageType.ProjectFoldersSnapshot,
          channel: 'state',
          correlationId: message.id,
          payload: { folders: this.deps.getProjectFolderCandidates() }
        });
        break;
      case BridgeMessageType.ConversationProjectSet:
        if (!message.payload) return;
        if (!this.deps.setConversationProjectFolder(message.payload)) {
          this.deps.webview.post(clientId, {
            id: createMessageId(),
            type: BridgeMessageType.Error,
            channel: 'diagnostics',
            correlationId: message.id,
            payload: { requestType: message.type, message: '无法设置对话项目归属。' }
          });
        }
        break;
      case BridgeMessageType.WorkEnvironmentSelect:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkEnvironmentEventType.ConversationSelectRequested, payload: message.payload });
        this.deps.requestSnapshot(message.payload.conversationId);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkEnvironmentUpsert:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkEnvironmentEventType.UpsertRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkEnvironmentRemove:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkEnvironmentEventType.RemoveRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkEnvironmentImportFromVscode:
        if (!this.deps.isHydrated()) return;
        void this.deps.importWorkEnvironmentsFromVscode().then(() => this.deps.requestSnapshot()).catch((error) => this.postRequestError(clientId, message.type, error instanceof Error ? error.message : '无法从 VS Code 导入工作环境。', message.id));
        break;
      case BridgeMessageType.WorkEnvironmentPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkEnvironmentEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkEnvironmentPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkEnvironmentEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.CheckpointPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CheckpointEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.CheckpointPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CheckpointEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.CheckpointDismiss:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CheckpointEventType.DismissRequested, payload: { checkpointId: message.payload.checkpointId } });
        this.deps.requestSnapshot(message.payload.conversationId);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.CheckpointRestore:
        if (message.payload) void this.handleCheckpointRestore(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.CheckpointDiffOpen:
        if (message.payload) void this.handleCheckpointDiffOpen(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.Ready:
        this.sendBridgeHello(clientId, message.id);
        if (!this.deps.isHydrated()) break;
        if (this.deps.clients.getOrUnknown(clientId).meta.kind === 'globalSettings') {
          for (const section of GLOBAL_SETTINGS_SECTIONS) {
            this.deps.webview.subscribe(clientId, globalSettingsStreamId(section));
            void this.deps.globalSettingsBridge.postSnapshot(clientId, section, message.id);
          }
          this.deps.webview.subscribe(clientId, GLOBAL_CLIENT_STATE_STREAM_ID);
          this.deps.requestSnapshot();
        } else {
          this.deps.webview.subscribe(clientId, GLOBAL_CLIENT_STATE_STREAM_ID);
          this.deps.requestSnapshot();
        }
        break;
      case BridgeMessageType.Ping:
        this.deps.webview.post(clientId, {
          id: createMessageId(),
          type: BridgeMessageType.Pong,
          channel: 'control',
          correlationId: message.id,
          payload: { text: message.payload?.text ?? 'pong', receivedAt: Date.now() }
        });
        break;
      case BridgeMessageType.GetWorkspaceInfo:
        this.deps.webview.post(clientId, {
          id: createMessageId(),
          type: BridgeMessageType.WorkspaceInfo,
          channel: 'control',

          correlationId: message.id,
          payload: {
            name: vscode.workspace.name ?? '',
            folders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
          }
        });
        break;
      case BridgeMessageType.ShowInfo:
        if (message.payload?.message) void vscode.window.showInformationMessage(message.payload.message);
        break;
      default:
        break;
    }
  }

  private async enqueueAfterConversationLoaded(conversationId: string, action: () => void): Promise<void> {
    try {
      await this.deps.ensureConversationDetailLoaded(conversationId);
      action();
      this.deps.requestSnapshot(conversationId);
    } catch (error) {
      console.warn('[LimCode] Failed to hydrate conversation before command.', error);
    }
  }


  private handleClientResync(clientId: BridgeClientId, streamId: string | undefined, conversationId: string | undefined): void {
    this.subscribeRequestedStream(clientId, streamId, conversationId);
    const requestedConversationId = conversationId ?? conversationIdFromClientStateStreamId(streamId ?? '');
    if (!requestedConversationId) {
      this.deps.requestSnapshot();
      return;
    }
    this.deps.requestSnapshot(requestedConversationId);
  }

  private async postConversationTimelinePage(
    clientId: BridgeClientId,
    payload: ConversationTimelinePageRequest,
    correlationId?: string
  ): Promise<void> {
    try {
      this.deps.webview.subscribe(clientId, conversationTimelineStreamId(payload.conversationId));
      const page = await this.deps.storage.loadConversationTimelinePage(payload);
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.ConversationTimelinePageSnapshot,
        channel: 'state',
        scope: { kind: 'conversation', id: payload.conversationId },
        correlationId,
        payload: page
      });
    } catch (error) {
      console.warn('[LimCode] Failed to load conversation timeline page.', error);
      this.postRequestError(clientId, BridgeMessageType.ConversationTimelinePageGet, '无法加载对话消息分页。', correlationId);
    }
  }

  private async postRunHistoryPage(
    clientId: BridgeClientId,
    payload: { conversationId: string; cursor?: string; limit?: number },
    correlationId?: string
  ): Promise<void> {
    try {
      const page = await this.deps.storage.loadConversationRunHistoryPage(payload);
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.RunHistoryPageSnapshot,
        channel: 'state',
        correlationId,
        payload: page
      });
    } catch (error) {
      console.warn('[LimCode] Failed to load run history page.', error);
      this.postRequestError(clientId, BridgeMessageType.RunHistoryPageGet, '无法加载运行历史列表。', correlationId);
    }
  }

  private async postRunHistoryDetail(clientId: BridgeClientId, payload: { conversationId: string; runId?: string; messageId?: string }, correlationId?: string): Promise<void> {
    try {
      const detail = await this.deps.storage.loadConversationRunDetail(payload);
      if (!detail) {
        this.postRequestError(clientId, BridgeMessageType.RunHistoryDetailGet, '无法找到该运行详情。', correlationId);
        return;
      }
      this.deps.webview.post(clientId, { id: createMessageId(), type: BridgeMessageType.RunHistoryDetailSnapshot, channel: 'state', correlationId, payload: detail });
    } catch (error) {
      console.warn('[LimCode] Failed to load run history detail.', error);
      this.postRequestError(clientId, BridgeMessageType.RunHistoryDetailGet, '无法加载运行详情。', correlationId);
    }
  }

  private async postLlmDryRun(clientId: BridgeClientId, payload: { conversationId: string; runId?: string; messageId?: string; invocationId?: string; compressionBlockId?: string; includeApiKey?: boolean }, correlationId?: string): Promise<void> {
    try {
      if (payload.compressionBlockId) {
        await this.postCompressionLlmDryRun(clientId, payload as { conversationId: string; compressionBlockId: string; invocationId?: string; includeApiKey?: boolean }, correlationId);
        return;
      }

      const runId = payload.runId ?? (payload.messageId ? await this.deps.storage.resolveConversationRunIdForMessage(payload.conversationId, payload.messageId) : undefined);
      if (!runId) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '无法根据这条消息找到对应的 run。', correlationId);
        return;
      }

      await this.ensureRunDetailHydrated(payload.conversationId, runId);
      const run = this.findRunEntity(runId);
      if (run === undefined) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '当前会话中无法找到该 run，不能构建 dry-run 请求。', correlationId);
        return;
      }

      const invocation = this.findInvocationForDryRun({ run, messageId: payload.messageId, invocationId: payload.invocationId });
      if (invocation === undefined) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '无法找到本次 LLM 调用快照，不能构建历史 dry-run 请求。', correlationId);
        return;
      }

      const invocationData = this.deps.world.get(invocation, LlmInvocation);
      const request = buildLlmStartRequestForRun(this.deps.world, { run, invocation, requestId: `dryrun-${invocationData?.id ?? runId}-${Date.now()}` });
      if (!request) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '无法从当前 ECS 状态构建本次 LLM 请求。', correlationId);
        return;
      }

      const dryRun = await this.deps.llm.dryRun(request, { includeApiKey: payload.includeApiKey === true });
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.LlmDryRunSnapshot,
        channel: 'state',
        correlationId,
        payload: { conversationId: payload.conversationId, runId, ...(invocationData ? { invocationId: invocationData.id, settingsSnapshot: invocationData.settings } : {}), ...dryRun }
      });
    } catch (error) {
      console.warn('[LimCode] Failed to dry-run LLM request.', error);
      this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, error instanceof Error ? error.message : '无法生成 LLM dry-run curl。', correlationId);
    }
  }

  private async postCompressionLlmDryRun(
    clientId: BridgeClientId,
    payload: { conversationId: string; compressionBlockId: string; invocationId?: string; includeApiKey?: boolean },
    correlationId?: string
  ): Promise<void> {
    try {
      await this.deps.ensureConversationDetailLoaded(payload.conversationId);
      const blockEntity = this.findCompressionBlockEntity(payload.compressionBlockId);
      const block = blockEntity !== undefined ? this.deps.world.get(blockEntity, CompressionBlock) : undefined;
      if (blockEntity === undefined || !block) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '无法找到该压缩块，不能构建 dry-run 请求。', correlationId);
        return;
      }
      if (block.methodKind === 'openai_responses_compact') {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, 'OpenAI 原生压缩暂不支持 curl dry-run。', correlationId);
        return;
      }

      const invocationEntity = this.findCompressionInvocation(blockEntity, payload.invocationId);
      const invocation = invocationEntity !== undefined ? this.deps.world.get(invocationEntity, LlmInvocation) : undefined;
      if (!invocation?.settings) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '无法找到本次压缩调用快照，不能构建 dry-run 请求。', correlationId);
        return;
      }

      const request = this.buildCompressionSummaryDryRunRequest(payload.conversationId, payload.compressionBlockId, invocation.id, invocation.settings);
      if (!request) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '无法从压缩块来源构建 dry-run 请求。', correlationId);
        return;
      }

      const dryRun = await this.deps.llm.dryRun(request, { includeApiKey: payload.includeApiKey === true });
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.LlmDryRunSnapshot,
        channel: 'state',
        correlationId,
        payload: { conversationId: payload.conversationId, compressionBlockId: payload.compressionBlockId, invocationId: invocation.id, settingsSnapshot: invocation.settings, ...dryRun }
      });
    } catch (error) {
      console.warn('[LimCode] Failed to dry-run compression LLM request.', error);
      this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, error instanceof Error ? error.message : '无法生成压缩 LLM dry-run curl。', correlationId);
    }
  }

  private buildCompressionSummaryDryRunRequest(
    conversationId: string,
    blockId: string,
    invocationId: string,
    settingsSnapshot: LlmInvocationSettingsSnapshotRecord
  ): import('../world/modules/llm/contracts').LlmStartRequest | undefined {
    const blockEntity = this.findCompressionBlockEntity(blockId);
    if (blockEntity === undefined) return undefined;
    const contents = this.compressionSourceContents(blockEntity);
    if (contents.length === 0) return undefined;
    const systemPrompt = 'You have written a partial transcript for the initial task above. Please write a summary of the transcript. The purpose of this summary is to provide continuity so you can continue to make progress towards solving the task in a future context, where the raw history above may not be accessible and will be replaced with this summary. Write down anything that would be helpful, including the state, next steps, learnings etc. You must wrap your summary in a <summary></summary> block.';
    const transcript = renderContentsForSummary(contents);
    return {
      id: `dryrun-${invocationId}-${Date.now()}`,
      invocationId,
      systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: `Transcript:\n\n${transcript}` }] }],
      tools: [],
      conversationId,
      settingsSnapshot
    };
  }

  private compressionSourceContents(block: number): MessageContent[] {
    return this.deps.world.query(CompressionBlockSourceLink)
      .map((entity) => this.deps.world.get(entity, CompressionBlockSourceLink))
      .filter((link): link is NonNullable<typeof link> => !!link && link.block === block && link.source !== undefined)
      .sort((left, right) => left.order - right.order)
      .map((link) => link.source !== undefined ? this.deps.world.get(link.source, Message)?.content : undefined)
      .filter((content): content is MessageContent => !!content);
  }



  private async postLlmProviderModels(clientId: BridgeClientId, payload: LlmProviderModelsGetPayload, correlationId?: string): Promise<void> {
    try {
      const models = await withTimeout(this.deps.llm.listModels(payload.config), 60_000, '获取模型列表超时，请检查 Base URL、API Key 或网络代理设置。');
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.LlmProviderModelsSnapshot,
        channel: 'state',
        correlationId,
        payload: {
          configId: payload.config.id,
          provider: payload.config.provider,
          baseUrl: payload.config.baseUrl,
          models
        }
      });
    } catch (error) {
      console.warn('[LimCode] Failed to fetch LLM provider models.', error);
      this.postRequestError(clientId, BridgeMessageType.LlmProviderModelsGet, error instanceof Error ? error.message : '无法获取模型列表。', correlationId);
    }
  }

  private async postCheckpointGitStatus(clientId: BridgeClientId, correlationId?: string): Promise<void> {
    try {
      const status = await this.deps.storage.detectSystemGit();
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.CheckpointGitStatusSnapshot,
        channel: 'state',
        correlationId,
        payload: { status }
      });
    } catch (error) {
      this.postRequestError(clientId, BridgeMessageType.CheckpointGitStatusGet, error instanceof Error ? error.message : '无法检测系统 Git。', correlationId);
    }
  }

  private async postCheckpointShadowStats(clientId: BridgeClientId, correlationId?: string): Promise<void> {
    try {
      const stats = await this.deps.storage.collectShadowWorktreeStats();
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.CheckpointShadowStatsSnapshot,
        channel: 'state',
        correlationId,
        payload: { stats }
      });
    } catch (error) {
      this.postRequestError(clientId, BridgeMessageType.CheckpointShadowStatsGet, error instanceof Error ? error.message : '无法读取 shadow 仓库统计。', correlationId);
    }
  }

  private async handleCheckpointShadowDelete(clientId: BridgeClientId, storageKeys: string[], correlationId?: string): Promise<void> {
    try {
      await this.deps.storage.deleteShadowWorktrees(storageKeys);
      await this.postCheckpointShadowStats(clientId, correlationId);
    } catch (error) {
      this.postRequestError(clientId, BridgeMessageType.CheckpointShadowDelete, error instanceof Error ? error.message : '无法删除 shadow 仓库。', correlationId);
    }
  }

  private async postEditToolStatistics(clientId: BridgeClientId, correlationId?: string): Promise<void> {
    try {
      const statistics = await this.deps.storage.loadEditToolStatistics();
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.EditToolStatisticsSnapshot,
        channel: 'state',
        correlationId,
        payload: { statistics }
      });
    } catch (error) {
      this.postRequestError(clientId, BridgeMessageType.EditToolStatisticsGet, error instanceof Error ? error.message : '无法读取 edit 工具统计。', correlationId);
    }
  }

  private async handleCheckpointRestore(clientId: BridgeClientId, payload: CheckpointRestorePayload, correlationId?: string): Promise<void> {
    try {
      const result = await this.deps.storage.restoreShadowCheckpoint(payload);
      if (result.status === 'restored') {
        void vscode.window.showInformationMessage(`LimCode 回档完成：${result.message}`);
      } else {
        void vscode.window.showWarningMessage(`LimCode ${result.message}`);
      }
      this.postCheckpointRestoreResult(clientId, payload, result, correlationId);
    } catch (error) {
      const result = { status: 'failed' as const, message: error instanceof Error ? error.message : '回档失败。' };
      void vscode.window.showWarningMessage(`LimCode ${result.message}`);
      this.postCheckpointRestoreResult(clientId, payload, result, correlationId);
    }
  }

  private async handleCheckpointDiffOpen(clientId: BridgeClientId, payload: CheckpointDiffOpenPayload, correlationId?: string): Promise<void> {
    try {
      await this.deps.ensureConversationDetailLoaded(payload.conversationId);
      const checkpointEntity = this.findCheckpointEntity(payload.checkpointId);
      const checkpoint = checkpointEntity !== undefined ? this.deps.world.get(checkpointEntity, Checkpoint) : undefined;
      if (checkpointEntity === undefined || !checkpoint) {
        this.postCheckpointDiffOpenResult(clientId, payload, { status: 'failed', message: '无法找到该存档点。' }, correlationId);
        return;
      }
      const conversation = this.deps.world.get(checkpoint.conversation, Conversation);
      if (conversation?.id !== payload.conversationId) {
        this.postCheckpointDiffOpenResult(clientId, payload, { status: 'failed', message: '存档点不属于当前对话。' }, correlationId);
        return;
      }
      if (checkpoint.status !== 'created' || !checkpoint.commitSha) {
        this.postCheckpointDiffOpenResult(clientId, payload, { status: 'failed', message: checkpoint.message ?? '该存档点没有可查看的 shadow commit。' }, correlationId);
        return;
      }
      const shadowRepository = this.deps.world.get(checkpoint.shadowRepository, ShadowRepository);
      if (!shadowRepository?.storageKey) {
        this.postCheckpointDiffOpenResult(clientId, payload, { status: 'failed', message: '未找到此存档点关联的 shadow 仓库。' }, correlationId);
        return;
      }

      const result = await this.deps.storage.openShadowCheckpointDiff({
        checkpointId: checkpoint.id,
        conversationId: conversation.id,
        shadowRepositoryStorageKey: shadowRepository.storageKey,
        commitSha: checkpoint.commitSha,
        projectUri: checkpoint.projectUri,
        filePath: payload.filePath
      });
      this.postCheckpointDiffOpenResult(clientId, payload, result, correlationId);
    } catch (error) {
      const result = { status: 'failed' as const, message: error instanceof Error ? error.message : '无法打开差异视图。' };
      this.postCheckpointDiffOpenResult(clientId, payload, result, correlationId);
    }
  }

  private postCheckpointRestoreResult(clientId: BridgeClientId, payload: CheckpointRestorePayload, result: { status: 'restored' | 'failed'; message: string; restoredFileCount?: number; removedFileCount?: number }, correlationId?: string): void {
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.CheckpointRestoreResult,
      channel: 'command',
      correlationId,
      payload: { checkpointId: payload.checkpointId, conversationId: payload.conversationId, result }
    });
  }

  private postCheckpointDiffOpenResult(clientId: BridgeClientId, payload: CheckpointDiffOpenPayload, result: { status: 'opened' | 'failed'; message: string }, correlationId?: string): void {
    if (result.status === 'failed') void vscode.window.showWarningMessage(`LimCode ${result.message}`);
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.CheckpointDiffOpenResult,
      channel: 'command',
      correlationId,
      payload: { checkpointId: payload.checkpointId, conversationId: payload.conversationId, filePath: payload.filePath, status: result.status, message: result.message }
    });
  }

  private findCheckpointEntity(checkpointId: string): number | undefined {
    return this.deps.world.query(Checkpoint).find((entity) => this.deps.world.get(entity, Checkpoint)?.id === checkpointId);
  }

  private async ensureRunDetailHydrated(conversationId: string, runId: string): Promise<void> {
    if (this.findRunEntity(runId) !== undefined) return;
    const detail = await this.deps.storage.loadConversationRunDetail({ conversationId, runId });
    if (!detail) return;
    await hydrateConversationDetail(this.deps.world, detail.state, conversationId);
  }

  private findRunEntity(runId: string): number | undefined {
    return this.deps.world.query(AgentRun).find((entity) => this.deps.world.get(entity, AgentRun)?.id === runId);
  }

  private findInvocationForDryRun(input: { run: number; messageId?: string; invocationId?: string }): number | undefined {
    if (input.invocationId) {
      const direct = this.deps.world.query(LlmInvocation).find((entity) => this.deps.world.get(entity, LlmInvocation)?.id === input.invocationId);
      if (direct !== undefined) return direct;
    }

    if (input.messageId) {
      const message = this.deps.world.query(Message).find((entity) => this.deps.world.get(entity, Message)?.id === input.messageId);
      if (message !== undefined) {
        const link = this.deps.world
          .query(MessageLlmInvocationLink)
          .map((entity) => this.deps.world.get(entity, MessageLlmInvocationLink))
          .find((candidate) => candidate?.message === message);
        if (link) return link.invocation;
      }
    }

    return this.deps.world
      .query(RunLlmInvocationLink)
      .map((entity) => this.deps.world.get(entity, RunLlmInvocationLink))
      .filter((link): link is NonNullable<typeof link> => !!link && link.run === input.run)
      .sort((left, right) => {
        const leftInvocation = this.deps.world.get(left.invocation, LlmInvocation);
        const rightInvocation = this.deps.world.get(right.invocation, LlmInvocation);
        return (rightInvocation?.createdAt ?? 0) - (leftInvocation?.createdAt ?? 0) || right.id.localeCompare(left.id);
      })[0]?.invocation;
  }


  private subscribeRequestedStream(clientId: BridgeClientId, streamId: string | undefined, conversationId: string | undefined): void {
    if (streamId) {
      this.deps.webview.subscribe(clientId, streamId);
      return;
    }
    if (conversationId) {
      this.deps.webview.subscribe(clientId, conversationClientStateStreamId(conversationId));
      return;
    }
    this.deps.webview.subscribe(clientId, GLOBAL_CLIENT_STATE_STREAM_ID);
  }

  private sendBridgeHello(clientId: BridgeClientId, correlationId?: string): void {
    const client = this.deps.clients.getOrUnknown(clientId);
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.Hello,
      channel: 'control',
      correlationId,
      payload: {
        clientId,
        attachedAt: client.attachedAt,
        meta: client.meta
      }
    });
  }

  private findCompressionBlockEntity(blockId: string): number | undefined {
    return this.deps.world.query(CompressionBlock).find((entity) => this.deps.world.get(entity, CompressionBlock)?.id === blockId);
  }

  private findCompressionInvocation(block: number, invocationId?: string): number | undefined {
    if (invocationId) {
      const direct = this.deps.world.query(LlmInvocation).find((entity) => this.deps.world.get(entity, LlmInvocation)?.id === invocationId);
      if (direct !== undefined) return direct;
    }
    return this.deps.world
      .query(CompressionBlockLlmInvocationLink)
      .map((entity) => this.deps.world.get(entity, CompressionBlockLlmInvocationLink))
      .filter((link): link is NonNullable<typeof link> => !!link && link.block === block)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0]?.invocation;
  }


  private postRequestError(clientId: BridgeClientId, requestType: string, message: string, correlationId?: string): void {
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.Error,
      channel: 'diagnostics',
      correlationId,
      payload: { requestType, message }
    });
  }
}

function renderContentsForSummary(contents: MessageContent[]): string {
  return contents.map((content, index) => `${index + 1}. ${content.role}: ${content.parts.map(renderSummaryPart).filter(Boolean).join('\n') || '[empty]'}`).join('\n\n');
}

function renderSummaryPart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[tool call] ${part.functionCall.name}: ${safeStringifyJson(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[tool result] ${part.functionResponse.name}: ${safeStringifyJson(part.functionResponse.response)}`;
  if (isInlineDataPart(part)) return `[inline data] ${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `[file] ${part.fileData.uri}`;
  if (isProviderContextPart(part)) return `[provider context] ${part.providerContext.format}:${part.providerContext.itemType ?? 'context'}`;
  return '';
}

function safeStringifyJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}


function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
