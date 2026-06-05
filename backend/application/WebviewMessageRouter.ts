import * as vscode from 'vscode';
import type { World } from '../ecs/types';
import type { WebviewCapability } from '../capabilities/types';
import { ChatEventType } from '../world/modules/chat/events';
import { AgentRunEventType } from '../world/modules/agentRun/events';
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
import type { GlobalSettingsBridge } from './GlobalSettingsBridge';
import type { ConversationSettingsBridge } from './ConversationSettingsBridge';
import type { SetConversationProjectFolderInput } from './BackendApplication';
import type { WebviewClientRegistry } from './WebviewClientRegistry';

export interface WebviewMessageRouterDeps {
  world: World;
  webview: WebviewCapability;
  clients: WebviewClientRegistry;
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
}
