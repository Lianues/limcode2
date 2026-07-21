import * as vscode from 'vscode';
import type { Entity, World } from '../ecs/types';
import { findUniqueById } from '../utils/uniqueIds';
import type { CommandCapability, FsCapability, LlmCapability, StorageCapability, WebviewCapability, FsPendingFileChangeProposal } from '../capabilities/types';
import { ChatEventType } from '../world/modules/chat/events';
import { AgentRunEventType } from '../world/modules/agentRun/events';
import { AgentRun } from '../world/modules/agentRun/components';
import { Conversation, Message, PartOf } from '../world/modules/chat/components';
import { LlmInvocation, MessageLlmInvocationLink, RunLlmInvocationLink } from '../world/modules/llm/components';
import { buildLlmStartRequestForRun } from '../world/modules/chat/systems/LlmDispatchSystem';
import { CompressionBlock, CompressionBlockLlmInvocationLink, CompressionBlockSourceLink } from '../world/modules/compression/components';
import { ToolEventType } from '../world/modules/tools/events';
import { PlanReviewEventType } from '../world/modules/plan/events';
import { ToolCall, ToolState } from '../world/modules/tools/components';
import { activeToolPolicyForRun, runForToolCall } from '../world/modules/agentRun/queries';
import { activeWorkEnvironmentForRun, pathAccessibleWorkEnvironmentsForRun, toPublicWorkEnvironmentRecord } from '../world/modules/workEnvironment/queries';
import { allowOutsideProjectPathsFromConfig } from '../world/modules/tools/definitions/filePathPolicy';
import { SkillEventType } from '../world/modules/skill/events';
import { WorkflowEventType } from '../world/modules/workflow/events';
import { WorkEnvironmentEventType } from '../world/modules/workEnvironment/events';
import { CheckpointEventType } from '../world/modules/checkpoint/events';
import { AgentEventType } from '../world/modules/agent/events';
import { CompressionEventType } from '../world/modules/compression/events';
import { RuntimeContextEventType } from '../world/modules/runtimeContext/events';
import { Checkpoint, ShadowRepository } from '../world/modules/checkpoint/components';
import { ModelProfile, ModelProfileScopeLink, type ModelProfileScopeLinkData } from '../world/modules/workflow/components';
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
  type BackgroundCommandKillPayload,
  type BackgroundCommandOutputGetPayload,
  type ChatModelOverrideRecord,
  type BridgeClientId,
  type CheckpointDiffOpenPayload,
  type CheckpointRestorePayload,
  type AttachmentOpenPayload,
  type AttachmentReloadPayload,
  type ContentPart,
  type FsStatGetPayload,
  type FsStatResultEntry,
  type ToolDiffOpenPayload,
  type PlanProposalExportPayload,
  type ConversationTimelinePageRequest,
  type LlmInvocationSettingsSnapshotRecord,
  type MessageContent,
  type MessageDeleteFromPayload,
  type MessageEditPayload,
  type MessageRetryFromPayload,
  type OperationResult,
  type LlmProviderModelsGetPayload,
  type ProjectFolderCandidateRecord,
  type RuleScope,
  type WebviewToExtensionMessage
} from '../../shared/protocol';
import { hydrateConversationDetail } from './clientStateHydration';
import { materializeAttachmentFileUri, resolveAttachmentForClient } from '../capabilities/vscodeStorage/attachmentStore';

import type { GlobalSettingsBridge } from './GlobalSettingsBridge';
import type { ConversationSettingsBridge } from './ConversationSettingsBridge';
import type { SetConversationProjectFolderInput } from './BackendApplication';
import type { WebviewClientRegistry } from './WebviewClientRegistry';

export interface WebviewMessageRouterDeps {
  world: World;
  webview: WebviewCapability;
  clients: WebviewClientRegistry;
  storage: StorageCapability;
  fs: FsCapability;
  llm: LlmCapability;
  command: CommandCapability;
  globalSettingsBridge: GlobalSettingsBridge;
  conversationSettingsBridge: ConversationSettingsBridge;
  isHydrated: () => boolean;
  requestSnapshot: (conversationId?: string) => void;
  requestPersist?: (reason: string) => void;
  flushPersistence?: (reason: string) => Promise<void>;
  ensureConversationDetailLoaded: (conversationId: string) => Promise<void>;
  ensureConversationTailLoaded: (conversationId: string) => Promise<void>;
  getProjectFolderCandidates: () => ProjectFolderCandidateRecord[];
  setConversationProjectFolder: (input: SetConversationProjectFolderInput) => boolean;
  importWorkEnvironmentsFromVscode: () => Promise<number>;
  refreshSkillCatalog: () => Promise<void>;
  refreshRulesCatalog: () => Promise<void>;
  saveRuleFile: (scope: RuleScope, content: string) => Promise<void>;
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
        if (!message.payload) return;
        {
          const payload = message.payload;
          this.upsertConversationModelOverride(payload.conversationId, payload.model);
          void this.enqueueAfterConversationTailLoaded(payload.conversationId, () => {
            this.deps.world.enqueue({ type: ChatEventType.Send, payload });
          });
        }
        break;
      case BridgeMessageType.ChatAbort:
        if (!this.deps.isHydrated() || !message.payload) return;
        if (!this.conversationExists(message.payload.conversationId)) {
          this.postOperationResult(clientId, { ok: false, operation: message.type, targetId: message.payload.conversationId, code: 'not_found', message: '找不到要停止的对话。' }, message.id);
          return;
        }
        this.deps.world.enqueue({ type: AgentRunEventType.CancelConversation, payload: { conversationId: message.payload.conversationId, reason: 'chat_abort' } });
        this.postOperationResult(clientId, { ok: true, operation: message.type, targetId: message.payload.conversationId }, message.id);
        break;
      case BridgeMessageType.LlmRetryCancel:
        if (!this.deps.isHydrated() || !message.payload?.requestId) return;
        this.deps.llm.cancelRetry(message.payload.requestId);
        break;
      case BridgeMessageType.MessageEdit:
        if (!this.deps.isHydrated() || !message.payload) return;
        {
          const payload = message.payload;
          this.upsertConversationModelOverride(payload.conversationId, payload.model);
          void this.handleMessageEdit(payload);
        }
        break;
      case BridgeMessageType.MessageDeleteFrom:
        if (!this.deps.isHydrated() || !message.payload) return;
        {
          const payload = message.payload;
          void this.handleMessageDeleteFrom(clientId, payload, message.id);
        }
        break;
      case BridgeMessageType.MessageRetryFrom:
        if (!this.deps.isHydrated() || !message.payload) return;
        {
          const payload = message.payload;
          this.upsertConversationModelOverride(payload.conversationId, payload.model);
          void this.handleMessageRetryFrom(clientId, payload, message.id);
        }
        break;
      case BridgeMessageType.ToolPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('toolPolicy.scope.set');
        break;
      case BridgeMessageType.ToolPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('toolPolicy.scope.clear');
        break;
      case BridgeMessageType.SkillPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: SkillEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('skillPolicy.scope.set');
        break;
      case BridgeMessageType.SkillPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: SkillEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('skillPolicy.scope.clear');
        break;
      case BridgeMessageType.SkillCatalogRefresh:
        if (!this.deps.isHydrated()) return;
        void this.deps.refreshSkillCatalog().catch((error) => this.postRequestError(clientId, message.type, error instanceof Error ? error.message : '无法刷新技能目录。', message.id));
        break;
      case BridgeMessageType.RulesFileSave:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.deps.saveRuleFile(message.payload.scope, message.payload.content).catch((error) => this.postRequestError(clientId, message.type, error instanceof Error ? error.message : '无法保存规则文件。', message.id));
        break;
      case BridgeMessageType.RulesCatalogRefresh:
        if (!this.deps.isHydrated()) return;
        void this.deps.refreshRulesCatalog().catch((error) => this.postRequestError(clientId, message.type, error instanceof Error ? error.message : '无法刷新规则目录。', message.id));
        break;
      case BridgeMessageType.ToolExecutionApprove:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ExecutionApproveRequested, payload: message.payload });
        break;
      case BridgeMessageType.ToolExecutionReject:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ExecutionRejectRequested, payload: message.payload });
        break;
      case BridgeMessageType.ToolExecutionCancel:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ExecutionCancelRequested, payload: message.payload });
        break;
      case BridgeMessageType.ToolDiffOpen:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.handleToolDiffOpen(message.payload).catch((error) => {
          const messageText = error instanceof Error ? error.message : '无法打开实时差异视图。';
          void vscode.window.showWarningMessage(`LimCode ${messageText}`);
        });
        break;
      case BridgeMessageType.ToolChangeApply:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ChangeApplyRequested, payload: message.payload });
        void this.deps.fs.closePendingFileChangeDiff(message.payload.toolCallId, message.payload.conversationId);
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
      case BridgeMessageType.AskUserAnswerSubmit:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.AskUserAnswerSubmitted, payload: message.payload });
        break;
      case BridgeMessageType.PlanProposalApprove:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: PlanReviewEventType.ProposalApproveRequested, payload: message.payload });
        break;
      case BridgeMessageType.PlanProposalRequestChanges:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: PlanReviewEventType.ProposalChangesRequested, payload: message.payload });
        break;
      case BridgeMessageType.PlanProposalReject:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: PlanReviewEventType.ProposalRejectRequested, payload: message.payload });
        break;
      case BridgeMessageType.PlanProposalExport:
        if (!message.payload) return;
        void this.handlePlanProposalExport(message.payload).catch((error) => {
          const messageText = error instanceof Error ? error.message : '无法导出 Plan。';
          this.postRequestError(clientId, message.type, messageText, message.id);
          void vscode.window.showErrorMessage(`LimCode: ${messageText}`);
        });
        break;
      case BridgeMessageType.AgentRunCancel:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.Cancel, message.payload, message.id, { rejectTerminal: true });
        break;
      case BridgeMessageType.AgentRunPause:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.Pause, message.payload, message.id, { rejectTerminal: true });
        break;
      case BridgeMessageType.AgentRunResume:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.Resume, message.payload, message.id);
        break;
      case BridgeMessageType.AgentRunRetry:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.Retry, message.payload, message.id);
        break;
      case BridgeMessageType.AgentRunRegenerate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.Regenerate, message.payload, message.id);
        break;
      case BridgeMessageType.AgentRunMarkStale:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.MarkStale, message.payload, message.id, { rejectTerminal: true });
        break;
      case BridgeMessageType.QueuePromote:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.Promote, message.payload, message.id, { requireQueued: true });
        break;
      case BridgeMessageType.QueueRemove:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.RemoveQueued, message.payload, message.id, { requireQueued: true });
        break;
      case BridgeMessageType.QueueReorder:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueQueueReorderOperation(clientId, message.type, message.payload, message.id);
        break;
      case BridgeMessageType.QueuePause:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.PauseQueue, message.payload, message.id, { requireQueued: true });
        break;
      case BridgeMessageType.QueueResume:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.ResumeQueue, message.payload, message.id, { requireQueued: true });
        break;
      case BridgeMessageType.QueueResumeAll:
        if (!this.deps.isHydrated() || !message.payload) return;
        if (!this.conversationExists(message.payload.conversationId)) {
          this.postOperationResult(clientId, { ok: false, operation: message.type, targetId: message.payload.conversationId, code: 'not_found', message: '找不到队列所属对话。' }, message.id);
          return;
        }
        this.deps.world.enqueue({ type: AgentRunEventType.ResumeQueueConversation, payload: message.payload });
        this.postOperationResult(clientId, { ok: true, operation: message.type, targetId: message.payload.conversationId }, message.id);
        break;
      case BridgeMessageType.QueueInputUpdate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.enqueueRunOperation(clientId, message.type, AgentRunEventType.UpdateQueuedInput, message.payload, message.id, { requireQueued: true });
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
        this.deps.requestPersist?.('systemPrompt.scope.set');
        break;
      case BridgeMessageType.SystemPromptScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.SystemPromptScopeClear, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('systemPrompt.scope.clear');
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
      case BridgeMessageType.WorkflowCreate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkflowEventType.Create, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkflowUpdate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkflowEventType.Update, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkflowDelete:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkflowEventType.Delete, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ConversationWorkflowSelect:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkflowEventType.ConversationSelect, payload: message.payload });
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
      case BridgeMessageType.CompressionCreate: {
        if (!this.deps.isHydrated() || !message.payload) {
          this.logCompressionRoute('create.skipNotReady', { hydrated: this.deps.isHydrated(), hasPayload: !!message.payload });
          return;
        }
        const payload = message.payload;
        this.logCompressionRoute('create.received', {
          payload,
          beforeLoad: this.compressionRouteConversationDebug(payload.conversationId)
        });
        void (payload.startMessageId || payload.endMessageId
          ? this.enqueueAfterTimelineRangeLoaded({ conversationId: payload.conversationId, mode: 'between', startMessageId: payload.startMessageId, endMessageId: payload.endMessageId }, () => {
            this.logCompressionRoute('create.enqueueAfterRangeLoaded', {
              payload,
              afterLoad: this.compressionRouteConversationDebug(payload.conversationId)
            });
            this.deps.world.enqueue({ type: CompressionEventType.Create, payload });
          })
          : this.enqueueAfterConversationLoaded(payload.conversationId, () => {
            this.logCompressionRoute('create.enqueueAfterConversationLoaded', {
              payload,
              afterLoad: this.compressionRouteConversationDebug(payload.conversationId)
            });
            this.deps.world.enqueue({ type: CompressionEventType.Create, payload });
          }));
        break;
      }
      case BridgeMessageType.CompressionDelete:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.enqueueAfterConversationLoaded(message.payload.conversationId, () => {
          this.deps.world.enqueue({ type: CompressionEventType.Delete, payload: message.payload });
        });
        break;
      case BridgeMessageType.CompressionUpdate:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.enqueueAfterConversationLoaded(message.payload.conversationId, () => {
          this.deps.world.enqueue({ type: CompressionEventType.Update, payload: message.payload });
        });
        break;
      case BridgeMessageType.CompressionRegenerate:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.enqueueAfterConversationLoaded(message.payload.conversationId, () => {
          this.deps.world.enqueue({ type: CompressionEventType.Regenerate, payload: message.payload });
        });
        break;
      case BridgeMessageType.CompressionDisable:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.enqueueAfterConversationLoaded(message.payload.conversationId, () => {
          this.deps.world.enqueue({ type: CompressionEventType.Disable, payload: message.payload });
        });
        break;
      case BridgeMessageType.CompressionEnable:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.enqueueAfterConversationLoaded(message.payload.conversationId, () => {
          this.deps.world.enqueue({ type: CompressionEventType.Enable, payload: message.payload });
        });
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
      case BridgeMessageType.PlanReviewPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: PlanReviewEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('planReviewPolicy.scope.set');
        break;
      case BridgeMessageType.PlanReviewPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: PlanReviewEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('planReviewPolicy.scope.clear');
        break;
      case BridgeMessageType.CheckpointPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CheckpointEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('checkpointPolicy.scope.set');
        break;
      case BridgeMessageType.CheckpointPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CheckpointEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('checkpointPolicy.scope.clear');
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
      case BridgeMessageType.AttachmentOpen:
        if (message.payload) void this.handleAttachmentOpen(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.AttachmentReload:
        if (message.payload) void this.postAttachmentReloadResult(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.Ready:
        this.sendBridgeHello(clientId, message.id);
        if (this.deps.clients.getOrUnknown(clientId).meta.kind === 'globalSettings') {
          // 流订阅不依赖 hydration 状态，提前注册可确保 hydration 完成后的快照不会丢失。
          // requestSnapshot 在未 hydrated 时自动排队，hydration 完成后由 flushPendingSnapshots 投递。
          for (const section of GLOBAL_SETTINGS_SECTIONS) {
            this.deps.webview.subscribe(clientId, globalSettingsStreamId(section));
          }
          this.deps.webview.subscribe(clientId, GLOBAL_CLIENT_STATE_STREAM_ID);
          this.deps.requestSnapshot();
          if (!this.deps.isHydrated()) break;
          // 仅在数据就绪时立即推送 settings section 快照。
          for (const section of GLOBAL_SETTINGS_SECTIONS) {
            void this.deps.globalSettingsBridge.postSnapshot(clientId, section, message.id);
          }
        } else {
          this.deps.webview.subscribe(clientId, GLOBAL_CLIENT_STATE_STREAM_ID);
          this.deps.requestSnapshot();
          if (!this.deps.isHydrated()) break;
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

      case BridgeMessageType.FsStatGet:
        if (message.payload) void this.postFsStatResult(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.BackgroundCommandOutputGet:
        if (message.payload) this.postBackgroundCommandOutputResult(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.BackgroundCommandKill:
        if (message.payload) this.postBackgroundCommandKillResult(clientId, message.payload, message.id);
        break;
      default:
        break;
    }
  }


  private enqueueRunOperation(
    clientId: BridgeClientId,
    operation: string,
    eventType: (typeof AgentRunEventType)[keyof typeof AgentRunEventType],
    payload: { runId: string; conversationId?: string },
    correlationId?: string,
    options: { rejectTerminal?: boolean; requireQueued?: boolean } = {}
  ): void {
    let runEntity: Entity | undefined;
    try {
      runEntity = this.findRunEntity(payload.runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '运行 ID 重复。';
      this.postOperationResult(clientId, { ok: false, operation, targetId: payload.runId, code: 'duplicate_id', message }, correlationId);
      return;
    }
    const run = runEntity !== undefined ? this.deps.world.get(runEntity, AgentRun) : undefined;
    if (runEntity === undefined || !run) {
      this.postOperationResult(clientId, { ok: false, operation, targetId: payload.runId, code: 'not_found', message: '找不到目标 AgentRun。' }, correlationId);
      return;
    }
    if (options.rejectTerminal && isTerminalAgentRunStatus(run.status)) {
      this.postOperationResult(clientId, { ok: false, operation, targetId: payload.runId, code: 'already_terminal', message: '目标 AgentRun 已是终态。' }, correlationId);
      return;
    }
    if (options.requireQueued && run.status !== 'queued') {
      this.postOperationResult(clientId, { ok: false, operation, targetId: payload.runId, code: 'invalid_state', message: '目标 AgentRun 不在队列中。' }, correlationId);
      return;
    }
    if (payload.conversationId && !this.conversationExists(payload.conversationId)) {
      this.postOperationResult(clientId, { ok: false, operation, targetId: payload.runId, code: 'not_found', message: '找不到目标对话。' }, correlationId);
      return;
    }
    this.deps.world.enqueue({ type: eventType, payload });
    this.postOperationResult(clientId, { ok: true, operation, targetId: payload.runId }, correlationId);
  }

  private enqueueQueueReorderOperation(
    clientId: BridgeClientId,
    operation: string,
    payload: { conversationId: string; runIds: string[] },
    correlationId?: string
  ): void {
    if (!this.conversationExists(payload.conversationId)) {
      this.postOperationResult(clientId, { ok: false, operation, targetId: payload.conversationId, code: 'not_found', message: '找不到队列所属对话。' }, correlationId);
      return;
    }
    for (const runId of payload.runIds) {
      let runEntity: Entity | undefined;
      try {
        runEntity = this.findRunEntity(runId);
      } catch (error) {
        const message = error instanceof Error ? error.message : '运行 ID 重复。';
        this.postOperationResult(clientId, { ok: false, operation, targetId: runId, code: 'duplicate_id', message }, correlationId);
        return;
      }
      const run = runEntity !== undefined ? this.deps.world.get(runEntity, AgentRun) : undefined;
      if (!run) {
        this.postOperationResult(clientId, { ok: false, operation, targetId: runId, code: 'not_found', message: '找不到队列中的 AgentRun。' }, correlationId);
        return;
      }
      if (run.status !== 'queued') {
        this.postOperationResult(clientId, { ok: false, operation, targetId: runId, code: 'invalid_state', message: '只能重排 queued 状态的 AgentRun。' }, correlationId);
        return;
      }
    }
    this.deps.world.enqueue({ type: AgentRunEventType.ReorderQueue, payload });
    this.postOperationResult(clientId, { ok: true, operation, targetId: payload.conversationId }, correlationId);
  }

  private conversationExists(conversationId: string): boolean {
    return findUniqueById(this.deps.world, Conversation, conversationId) !== undefined;
  }

  private messageExists(conversationId: string, messageId: string): boolean {
    const conversation = findUniqueById(this.deps.world, Conversation, conversationId);
    if (conversation === undefined) return false;
    let found = false;
    for (const entity of this.deps.world.query(Message, PartOf)) {
      if (this.deps.world.get(entity, PartOf)?.parent !== conversation || this.deps.world.get(entity, Message)?.id !== messageId) continue;
      if (found) throw new Error(`Duplicate Message id: ${messageId}`);
      found = true;
    }
    return found;
  }


  private logCompressionRoute(stage: string, payload: Record<string, unknown>): void {
    console.info('[LimCode][Compression][Router]', stage, payload);
  }

  private compressionRouteConversationDebug(conversationId: string): Record<string, unknown> {
    const conversation = this.deps.world.query(Conversation).find((entity) => this.deps.world.get(entity, Conversation)?.id === conversationId);
    if (conversation === undefined) {
      return { conversationId, conversationFound: false };
    }
    const messages = this.deps.world
      .query(Message, PartOf)
      .filter((entity) => this.deps.world.get(entity, PartOf)?.parent === conversation)
      .map((entity) => this.deps.world.get(entity, Message))
      .filter((record): record is NonNullable<typeof record> => !!record)
      .sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const blocks = this.deps.world
      .query(CompressionBlock)
      .map((entity) => this.deps.world.get(entity, CompressionBlock))
      .filter((block): block is NonNullable<typeof block> => !!block && block.conversation === conversation)
      .sort((left, right) => (left.anchorSeq ?? left.endSeq ?? 0) - (right.anchorSeq ?? right.endSeq ?? 0) || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    return {
      conversationId,
      conversationFound: true,
      hydratedMessageCount: messages.length,
      firstSeq: messages[0]?.seq,
      lastSeq: messages[messages.length - 1]?.seq,
      streamingMessageCount: messages.filter((message) => message.status === 'streaming').length,
      compressionBlockCount: blocks.length,
      runningCompressionBlocks: blocks
        .filter((block) => block.status === 'pending' || block.status === 'running')
        .map((block) => ({ id: block.id, status: block.status, anchorSeq: block.anchorSeq, endSeq: block.endSeq }))
    };
  }


  private postBackgroundCommandOutputResult(clientId: BridgeClientId, payload: BackgroundCommandOutputGetPayload, correlationId: string): void {
    const processId = payload.processId.trim();
    if (!processId) {
      this.postRequestError(clientId, BridgeMessageType.BackgroundCommandOutputGet, '缺少后台命令 processId。', correlationId);
      return;
    }
    const consume = payload.consume !== false;
    const output = this.deps.command.readOutput(processId, { maxOutputLines: 1000, maxOutputChars: 100_000 }, { consume });
    const terminal = output.running === false || output.status === 'exited' || output.status === 'killed' || output.status === 'not_found';
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.BackgroundCommandOutputResult,
      channel: 'state',
      correlationId,
      payload: { ...output, processId, consumed: consume && terminal }
    });
  }

  private postBackgroundCommandKillResult(clientId: BridgeClientId, payload: BackgroundCommandKillPayload, correlationId: string): void {
    const processId = payload.processId.trim();
    if (!processId) {
      this.postRequestError(clientId, BridgeMessageType.BackgroundCommandKill, '缺少后台命令 processId。', correlationId);
      return;
    }
    const output = this.deps.command.kill(processId);
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.BackgroundCommandOutputResult,
      channel: 'state',
      correlationId,
      payload: { ...output, processId: output.processId?.trim() || processId, consumed: false }
    });
  }

  private async postFsStatResult(clientId: BridgeClientId, payload: FsStatGetPayload, correlationId: string): Promise<void> {
    const resolvedPaths = resolveDroppedPaths(payload.paths ?? []);
    const results = await Promise.all(resolvedPaths.map((path) => statPath(path)));
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.FsStatResult,
      channel: 'control',
      correlationId,
      payload: { results }
    });
  }

  private async enqueueAfterConversationLoaded(conversationId: string, action: () => void): Promise<void> {
    try {
      await this.deps.ensureConversationDetailLoaded(conversationId);
      action();
    } catch (error) {
      console.warn('[LimCode] Failed to hydrate conversation before command.', error);
    }
  }

  private async enqueueAfterConversationTailLoaded(conversationId: string, action: () => void): Promise<void> {
    try {
      await this.deps.ensureConversationTailLoaded(conversationId);
    } catch (error) {
      console.warn('[LimCode] Failed to hydrate conversation tail before command.', error);
    }
    action();
  }

  private async handleMessageDeleteFrom(clientId: BridgeClientId, payload: MessageDeleteFromPayload, correlationId?: string): Promise<void> {
    try {
      await this.enqueueAfterTimelineRangeLoaded({ conversationId: payload.conversationId, mode: 'between', startMessageId: payload.messageId, endMessageId: payload.messageId, contextBeforeChunks: 1 }, () => undefined);
      const deletePayload = this.normalizeDeleteFromPayload(payload);
      if (!this.messageExists(deletePayload.conversationId, deletePayload.messageId)) {
        this.postOperationResult(clientId, { ok: false, operation: BridgeMessageType.MessageDeleteFrom, targetId: deletePayload.messageId, code: 'not_found', message: '找不到要删除的消息。' }, correlationId);
        return;
      }
      await this.deps.flushPersistence?.('before-message-delete-truncate');
      await this.deps.storage.truncateConversationTimeline({ conversationId: deletePayload.conversationId, anchorMessageId: deletePayload.messageId, keepAnchor: false });
      this.deps.world.enqueue({ type: ChatEventType.DeleteFrom, payload: deletePayload });
      this.postOperationResult(clientId, { ok: true, operation: BridgeMessageType.MessageDeleteFrom, targetId: deletePayload.messageId }, correlationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除消息前截断对话失败。';
      console.warn('[LimCode] Failed to truncate conversation before deleting messages.', error);
      this.postOperationResult(clientId, { ok: false, operation: BridgeMessageType.MessageDeleteFrom, targetId: payload.messageId, code: 'storage_failed', message }, correlationId);
    }
  }

  private normalizeDeleteFromPayload(payload: MessageDeleteFromPayload): MessageDeleteFromPayload {
    const boundaryMessageId = this.functionCallBoundaryForToolResponse(payload.conversationId, payload.messageId);
    return boundaryMessageId && boundaryMessageId !== payload.messageId ? { ...payload, messageId: boundaryMessageId } : payload;
  }

  private functionCallBoundaryForToolResponse(conversationId: string, messageId: string): string | undefined {
    const conversation = this.deps.world.query(Conversation).find((entity) => this.deps.world.get(entity, Conversation)?.id === conversationId);
    if (conversation === undefined) return undefined;
    const messages = this.deps.world
      .query(Message, PartOf)
      .filter((entity) => this.deps.world.get(entity, PartOf)?.parent === conversation)
      .sort((left, right) => (this.deps.world.get(left, Message)?.seq ?? 0) - (this.deps.world.get(right, Message)?.seq ?? 0));
    const index = messages.findIndex((entity) => this.deps.world.get(entity, Message)?.id === messageId);
    if (index < 0) return undefined;
    const message = this.deps.world.get(messages[index], Message);
    const response = message?.content.parts.find(isFunctionResponsePart);
    if (!response || !isFunctionResponsePart(response)) return undefined;
    const responseId = response.id?.trim();
    const responseName = response.functionResponse.name;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = this.deps.world.get(messages[cursor], Message);
      if (!candidate) continue;
      const matched = candidate.content.parts.some((part) => {
        if (!isFunctionCallPart(part)) return false;
        if (responseId && part.id?.trim() === responseId) return true;
        return !responseId && part.functionCall.name === responseName;
      });
      if (matched) return candidate.id;
      if (candidate.role === 'user' && !candidate.content.parts.some(isFunctionResponsePart)) break;
    }
    return undefined;
  }

  private async handleMessageEdit(payload: MessageEditPayload): Promise<void> {
    try {
      await this.enqueueAfterTimelineRangeLoaded({ conversationId: payload.conversationId, mode: 'between', startMessageId: payload.messageId, endMessageId: payload.messageId, contextBeforeChunks: 1 }, () => undefined);
      if (payload.deleteFollowing) {
        await this.deps.flushPersistence?.('before-message-edit-truncate');
        await this.deps.storage.truncateConversationTimeline({ conversationId: payload.conversationId, anchorMessageId: payload.messageId, keepAnchor: true });
      }
      this.deps.world.enqueue({ type: ChatEventType.Edit, payload });
    } catch (error) {
      console.warn('[LimCode] Failed to prepare conversation before editing message.', error);
    }
  }

  private async handleMessageRetryFrom(clientId: BridgeClientId, payload: MessageRetryFromPayload, correlationId?: string): Promise<void> {
    try {
      await this.enqueueAfterTimelineRangeLoaded({ conversationId: payload.conversationId, mode: 'between', startMessageId: payload.messageId, endMessageId: payload.messageId, contextBeforeChunks: 1 }, () => undefined);
      if (!this.messageExists(payload.conversationId, payload.messageId)) {
        this.postOperationResult(clientId, { ok: false, operation: BridgeMessageType.MessageRetryFrom, targetId: payload.messageId, code: 'not_found', message: '找不到要重试的消息。' }, correlationId);
        return;
      }
      await this.deps.flushPersistence?.('before-message-retry-truncate');
      await this.deps.storage.truncateConversationTimeline({ conversationId: payload.conversationId, anchorMessageId: payload.messageId, keepAnchor: false });
      this.deps.world.enqueue({ type: ChatEventType.RetryFrom, payload });
      this.postOperationResult(clientId, { ok: true, operation: BridgeMessageType.MessageRetryFrom, targetId: payload.messageId }, correlationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '重试消息前截断对话失败。';
      console.warn('[LimCode] Failed to truncate conversation before retrying message.', error);
      this.postOperationResult(clientId, { ok: false, operation: BridgeMessageType.MessageRetryFrom, targetId: payload.messageId, code: 'storage_failed', message }, correlationId);
    }
  }

  private async enqueueAfterTimelineRangeLoaded(
    request: {
      conversationId: string;
      mode: 'suffix' | 'prefix' | 'between';
      anchorMessageId?: string;
      startMessageId?: string;
      endMessageId?: string;
      contextBeforeChunks?: number;
    },
    action: () => void
  ): Promise<void> {
    try {
      const detail = await this.deps.storage.loadConversationTimelineRange(request);
      if (detail) await hydrateConversationDetail(this.deps.world, detail, request.conversationId);
      action();
    } catch (error) {
      console.warn('[LimCode] Failed to hydrate conversation timeline range before command.', error);
    }
  }


  private handleClientResync(clientId: BridgeClientId, streamId: string | undefined, conversationId: string | undefined): void {
    this.subscribeRequestedStream(clientId, streamId, conversationId);
    const requestedConversationId = conversationId ?? conversationIdFromClientStateStreamId(streamId ?? '');
    if (!requestedConversationId) {
      this.deps.requestSnapshot();
      return;
    }

    void this.enqueueAfterConversationTailLoaded(requestedConversationId, () => this.deps.requestSnapshot(requestedConversationId));
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

  private async handleToolDiffOpen(payload: ToolDiffOpenPayload): Promise<void> {
    if (payload.conversationId) await this.deps.ensureConversationDetailLoaded(payload.conversationId);
    const entity = this.findToolCallEntity(payload.toolCallId);
    const call = entity !== undefined ? this.deps.world.get(entity, ToolCall) : undefined;
    const state = entity !== undefined ? this.deps.world.get(entity, ToolState) : undefined;
    if (entity === undefined || !call || !state) {
      void vscode.window.showWarningMessage('LimCode 无法找到该工具调用。');
      return;
    }
    const proposal = this.pendingFileChangeProposal(state.result);
    if (!proposal) {
      void vscode.window.showWarningMessage('LimCode 该工具调用没有可预览的文件变更提案。');
      return;
    }

    const run = runForToolCall(this.deps.world, entity);
    const policy = run !== undefined ? activeToolPolicyForRun(this.deps.world, run) : undefined;
    const config = policy?.toolConfigs?.[call.name]?.config;
    const workEnvironment = run !== undefined ? activeWorkEnvironmentForRun(this.deps.world, run)?.data : undefined;
    const accessibleWorkEnvironments = run !== undefined
      ? pathAccessibleWorkEnvironmentsForRun(this.deps.world, run).map((item) => toPublicWorkEnvironmentRecord(item.data))
      : [];
    const result = await this.deps.fs.openPendingFileChangeDiff(proposal, {
      ...(workEnvironment ? { workEnvironment: toPublicWorkEnvironmentRecord(workEnvironment) } : {}),
      ...(accessibleWorkEnvironments.length > 0 ? { accessibleWorkEnvironments } : {}),
      allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(config, false),
      toolCallId: call.id,
      conversationId: payload.conversationId,
      onSave: (event) => {
        this.deps.world.enqueue({
          type: ToolEventType.ChangeApplyRequested,
          payload: {
            toolCallId: event.toolCallId ?? call.id,
            conversationId: event.conversationId ?? payload.conversationId
          }
        });
      }
    });
    if (result.status === 'failed') void vscode.window.showWarningMessage(`LimCode ${result.message}`);
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

  private async handleAttachmentOpen(clientId: BridgeClientId, payload: AttachmentOpenPayload, correlationId?: string): Promise<void> {
    try {
      const uri = await materializeAttachmentFileUri(this.deps.storage.paths, payload);
      if (!uri) {
        this.postRequestError(clientId, BridgeMessageType.AttachmentOpen, '无法找到附件文件。', correlationId);
        return;
      }
      await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法打开附件。';
      this.postRequestError(clientId, BridgeMessageType.AttachmentOpen, message, correlationId);
      void vscode.window.showWarningMessage(`LimCode ${message}`);
    }
  }

  private async postAttachmentReloadResult(clientId: BridgeClientId, payload: AttachmentReloadPayload, correlationId?: string): Promise<void> {
    const result = await resolveAttachmentForClient(this.deps.storage.paths, payload);
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.AttachmentReloadResult,
      channel: 'state',
      correlationId,
      payload: {
        request: payload,
        ...(result.part ? { part: result.part } : {}),
        status: result.status,
        ...(result.error ? { error: result.error } : {})
      }
    });
  }

  private findCheckpointEntity(checkpointId: string): number | undefined {
    return this.deps.world.query(Checkpoint).find((entity) => this.deps.world.get(entity, Checkpoint)?.id === checkpointId);
  }

  private findToolCallEntity(toolCallId: string): number | undefined {
    return this.deps.world.query(ToolCall, ToolState).find((entity) => this.deps.world.get(entity, ToolCall)?.id === toolCallId);
  }

  private pendingFileChangeProposal(result: unknown): FsPendingFileChangeProposal | undefined {
    const output = this.asPlainRecord(this.asPlainRecord(result)?.output);
    const proposal = this.asPlainRecord(output?.proposal);
    if (proposal?.kind !== 'file_change.proposal') return undefined;
    if (proposal.operation !== 'write' && proposal.operation !== 'edit') return undefined;
    if (typeof proposal.path !== 'string' || typeof proposal.baseContent !== 'string' || typeof proposal.targetContent !== 'string') return undefined;
    if (typeof proposal.baseExisted !== 'boolean' || !Array.isArray(proposal.applyHunks)) return undefined;
    return proposal as unknown as FsPendingFileChangeProposal;
  }

  private asPlainRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private async ensureRunDetailHydrated(conversationId: string, runId: string): Promise<void> {
    if (this.findRunEntity(runId) !== undefined) return;
    const detail = await this.deps.storage.loadConversationRunDetail({ conversationId, runId });
    if (!detail) return;
    await hydrateConversationDetail(this.deps.world, detail.state, conversationId);
  }

  private findRunEntity(runId: string): number | undefined {
    return findUniqueById(this.deps.world, AgentRun, runId);
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

  private upsertConversationModelOverride(conversationId: string, input: ChatModelOverrideRecord | undefined): void {
    const model = input?.model?.trim();
    const scopeId = conversationId.trim();
    if (!scopeId || !model) return;
    const conversation = this.deps.world.query(Conversation).find((entity) => this.deps.world.get(entity, Conversation)?.id === scopeId);
    if (conversation === undefined) return;
    const now = Date.now();
    const existing = this.latestConversationModelProfileLink(conversation, scopeId);
    const profile = existing?.link.modelProfile ?? this.deps.world.spawn();
    const profileId = existing ? this.deps.world.get(profile, ModelProfile)?.id ?? modelProfileIdForConversation(scopeId) : modelProfileIdForConversation(scopeId);
    this.deps.world.add(profile, ModelProfile, {
      id: profileId,
      name: '对话临时模型',
      ...(input?.providerConfigId?.trim() ? { providerConfigId: input.providerConfigId.trim() } : {}),
      ...(input?.provider ? { provider: input.provider } : {}),
      model
    });
    if (existing) {
      this.deps.world.add(existing.entity, ModelProfileScopeLink, { ...existing.link, conversation, scopeId, modelProfile: profile, updatedAt: now });
      return;
    }
    const link = this.deps.world.spawn();
    this.deps.world.add(link, ModelProfileScopeLink, {
      id: modelProfileScopeLinkIdForConversation(scopeId),
      scopeKind: 'conversation',
      scopeId,
      conversation,
      modelProfile: profile,
      role: 'active',
      createdAt: now,
      updatedAt: now
    });
  }

  private latestConversationModelProfileLink(conversation: Entity, scopeId: string): { entity: Entity; link: ModelProfileScopeLinkData } | undefined {
    return this.deps.world
      .query(ModelProfileScopeLink)
      .map((entity) => ({ entity, link: this.deps.world.get(entity, ModelProfileScopeLink) }))
      .filter((item): item is { entity: Entity; link: ModelProfileScopeLinkData } => !!item.link && item.link.role === 'active' && item.link.scopeKind === 'conversation' && (item.link.conversation === conversation || item.link.scopeId === scopeId))
      .sort((left, right) => (right.link.updatedAt || right.link.createdAt) - (left.link.updatedAt || left.link.createdAt) || right.entity - left.entity)[0];
  }

  private async handlePlanProposalExport(payload: PlanProposalExportPayload): Promise<void> {
    const markdown = payload.markdown.trim();
    if (!markdown) {
      void vscode.window.showWarningMessage('LimCode: 没有可导出的 Plan 内容。');
      return;
    }

    const fileName = safeMarkdownFileName(payload.suggestedFileName ?? 'plan.md');
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const target = await vscode.window.showSaveDialog({
      title: '导出 Plan Markdown',
      saveLabel: '导出 Plan',
      ...(workspaceFolder ? { defaultUri: vscode.Uri.joinPath(workspaceFolder.uri, fileName) } : {}),
      filters: {
        Markdown: ['md'],
        'All Files': ['*']
      }
    });
    if (!target) return;

    await vscode.workspace.fs.writeFile(target, Buffer.from(ensureTrailingNewline(markdown), 'utf8'));
    const targetPath = target.scheme === 'file' ? target.fsPath : target.toString(true);
    void vscode.window.showInformationMessage(`LimCode: Plan 已导出到 ${targetPath}`);
  }

  private postOperationResult(clientId: BridgeClientId, result: OperationResult, correlationId?: string): void {
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.OperationResult,
      channel: 'command',
      correlationId,
      payload: result
    });
    if (!result.ok && result.message) this.postRequestError(clientId, result.operation, result.message, correlationId);
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

function isTerminalAgentRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stale';
}

function modelProfileIdForConversation(conversationId: string): string { return `model-profile:conversation:${conversationId}`; }
function modelProfileScopeLinkIdForConversation(conversationId: string): string { return `model-profile-scope:conversation:${conversationId}`; }

function safeMarkdownFileName(input: string): string {
  const safe = input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/, '')
    .slice(0, 120)
    .trim();
  const base = safe || 'plan';
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

function ensureTrailingNewline(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`;
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

async function statPath(path: string): Promise<FsStatResultEntry> {
  try {
    const uri = vscode.Uri.file(path);
    const stat = await vscode.workspace.fs.stat(uri);
    const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
    return { path: normalizePath(path), isDirectory, exists: true };
  } catch {
    return { path: normalizePath(path), isDirectory: false, exists: false };
  }
}

/**
 * 从 webview 拖拽数据中解析出去重的绝对路径。
 *
 * webview 传来的 paths 是 dataTransfer 各 type 的原始 getData 结果，
 * 可能包含 file:// URI、VS Code 内部 JSON payload、纯文本路径等。
 * 这里统一提取出绝对路径并去重。
 */
function resolveDroppedPaths(rawValues: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const raw of rawValues) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    collectPathsFromPayload(trimmed, candidates);
  }
  return uniquePaths(candidates);
}

function collectPathsFromPayload(value: string, output: string[]): void {
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      collectPathsFromJson(JSON.parse(value), output, 0);
      return;
    } catch {
      collectEmbeddedUris(value, output);
      return;
    }
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') {
        output.push(parsed);
        return;
      }
    } catch {
      // fall through
    }
  }
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    output.push(trimmed);
  }
}

function collectPathsFromJson(value: unknown, output: string[], depth: number): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathsFromJson(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const scheme = typeof record.scheme === 'string' ? record.scheme : undefined;
  const path = typeof record.path === 'string' ? record.path : undefined;
  if (scheme && path) {
    output.push(path);
  }
  for (const key of ['fsPath', 'path', 'resource', 'uri', 'external', 'file', 'target', 'originalResource']) {
    if (key in record) collectPathsFromJson(record[key], output, depth + 1);
  }
}

function collectEmbeddedUris(value: string, output: string[]): void {
  for (const match of value.matchAll(/(?:file|vscode-remote|vscode-vfs):\/\/[^"'\]\},\s]+/gi)) {
    output.push(match[0]);
  }
  for (const match of value.matchAll(/"(?:fsPath|path|uri)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/gi)) {
    try {
      output.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      if (match[1]) output.push(match[1]);
    }
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const normalized = normalizePath(raw);
    if (!normalized || !looksLikeAbsolutePath(normalized)) continue;
    const key = normalized.replace(/\/+$/, '').toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizePath(value: string): string {
  let path = value.trim();
  // file:// URI → path
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      path = decodeURIComponent(path.replace(/^file:\/\//i, ''));
    }
  }
  // /f:/... → f:/...
  path = path.replace(/^\/([A-Za-z]:[\\/])/, '$1');
  // f://... → f:/...
  path = path.replace(/^([A-Za-z]):?\/\/(.+)$/, (_m, drive: string, rest: string) => `${drive.toUpperCase()}:/${rest.replace(/^\/+/, '')}`);
  // 统一为正斜杠
  path = path.replace(/\\/g, '/');
  // 去掉多余斜杠（保留 drive 冒号后的一个）
  path = path.replace(/^([A-Za-z]:)\/+/, '$1/').replace(/\/{2,}/g, '/');
  // 去掉尾部斜杠
  path = path.replace(/\/+$/, '');
  return path;
}

function looksLikeAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\//.test(value);
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
