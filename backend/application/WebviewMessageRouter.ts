import * as vscode from 'vscode';
import type { World } from '../ecs/types';
import type { WebviewCapability } from '../capabilities/types';
import { ChatEventType } from '../world/modules/chat/events';
import {
  BridgeMessageType,
  createMessageId,
  type BridgeClientId,
  type WebviewToExtensionMessage
} from '../../shared/protocol';
import type { LlmSettingsBridge } from './LlmSettingsBridge';
import type { WebviewClientRegistry } from './WebviewClientRegistry';

export interface WebviewMessageRouterDeps {
  world: World;
  webview: WebviewCapability;
  clients: WebviewClientRegistry;
  settingsBridge: LlmSettingsBridge;
  isHydrated: () => boolean;
  requestSnapshot: (sessionId?: string) => void;
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
        break;
      case BridgeMessageType.ClientResync:
        if (this.deps.isHydrated()) this.deps.requestSnapshot(message.payload?.sessionId);
        break;
      case BridgeMessageType.LlmSettingsGet:
        void this.deps.settingsBridge.postSnapshot(clientId, message.id);
        break;
      case BridgeMessageType.LlmSettingsUpdate:
        void this.deps.settingsBridge.update(message.payload, message.id);
        break;
      case BridgeMessageType.Ready:
        this.sendBridgeHello(clientId, message.id);
        if (this.deps.isHydrated()) {
          this.deps.requestSnapshot();
          void this.deps.settingsBridge.postSnapshot(clientId, message.id);
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
