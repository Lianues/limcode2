import * as vscode from 'vscode';
import type { World } from '../ecs/types';
import type { LlmCapability, StorageCapability, WebviewCapability } from '../capabilities/types';
import { ChatEventType } from '../world/modules/chat/events';
import { AgentRunEventType } from '../world/modules/agentRun/events';
import { AgentRun } from '../world/modules/agentRun/components';
import { buildLlmStartRequestForRun } from '../world/modules/chat/systems/LlmDispatchSystem';
import { ToolEventType } from '../world/modules/tools/events';
import {
  BridgeMessageType,
  GLOBAL_CLIENT_STATE_STREAM_ID,
  GLOBAL_SETTINGS_SECTIONS,
  conversationClientStateStreamId,
  conversationIdFromClientStateStreamId,
  conversationSettingsStreamId,
  globalSettingsStreamId,
  createMessageId,
  type BridgeClientId,
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
        this.deps.world.enqueue({ type: ChatEventType.Send, payload: message.payload });
        break;
      case BridgeMessageType.ChatAbort:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ChatEventType.Abort, payload: message.payload });
        this.deps.world.enqueue({ type: AgentRunEventType.CancelConversation, payload: { conversationId: message.payload.conversationId, reason: 'chat_abort' } });
        break;
      case BridgeMessageType.MessageEdit:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ChatEventType.Edit, payload: message.payload });
        break;
      case BridgeMessageType.MessageDeleteFrom:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ChatEventType.DeleteFrom, payload: message.payload });
        break;
      case BridgeMessageType.MessageRetryFrom:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ChatEventType.RetryFrom, payload: message.payload });
        break;
      case BridgeMessageType.ToolExecute:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.ExecuteRequested, payload: message.payload });
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
      case BridgeMessageType.ClientResync:
        this.handleClientResync(clientId, message.payload?.streamId, message.payload?.conversationId);
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
      case BridgeMessageType.Ready:
        this.sendBridgeHello(clientId, message.id);
        if (!this.deps.isHydrated()) break;
        if (this.deps.clients.getOrUnknown(clientId).meta.kind === 'globalSettings') {
          for (const section of GLOBAL_SETTINGS_SECTIONS) {
            this.deps.webview.subscribe(clientId, globalSettingsStreamId(section));
            void this.deps.globalSettingsBridge.postSnapshot(clientId, section, message.id);
          }
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

  private handleClientResync(clientId: BridgeClientId, streamId: string | undefined, conversationId: string | undefined): void {
    this.subscribeRequestedStream(clientId, streamId, conversationId);
    const requestedConversationId = conversationId ?? conversationIdFromClientStateStreamId(streamId ?? '');
    if (!requestedConversationId) {
      this.deps.requestSnapshot();
      return;
    }
    void this.deps.ensureConversationDetailLoaded(requestedConversationId)
      .then(() => this.deps.requestSnapshot(requestedConversationId))
      .catch((error) => console.warn('[LimCode] Failed to lazy-load conversation detail.', error));
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

  private async postLlmDryRun(clientId: BridgeClientId, payload: { conversationId: string; runId?: string; messageId?: string; includeApiKey?: boolean }, correlationId?: string): Promise<void> {
    try {
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

      const request = buildLlmStartRequestForRun(this.deps.world, { run, requestId: `dryrun-${runId}-${Date.now()}` });
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
        payload: { conversationId: payload.conversationId, runId, ...dryRun }
      });
    } catch (error) {
      console.warn('[LimCode] Failed to dry-run LLM request.', error);
      this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, error instanceof Error ? error.message : '无法生成 LLM dry-run curl。', correlationId);
    }
  }

  private async ensureRunDetailHydrated(conversationId: string, runId: string): Promise<void> {
    if (this.findRunEntity(runId) !== undefined) return;
    const detail = await this.deps.storage.loadConversationRunDetail({ conversationId, runId });
    if (!detail) return;
    hydrateConversationDetail(this.deps.world, detail.state, conversationId);
  }

  private findRunEntity(runId: string): number | undefined {
    return this.deps.world.query(AgentRun).find((entity) => this.deps.world.get(entity, AgentRun)?.id === runId);
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
