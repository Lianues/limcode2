import type * as vscode from 'vscode';
import {
  createMessageId,
  type BridgeClientId,
  type ExtensionToWebviewMessage,
  type WebviewClientMeta
} from '../../shared/protocol';
import type { WebviewCapability } from './types';

interface WebviewClientEntry {
  readonly id: BridgeClientId;
  readonly webview: vscode.Webview;
  readonly meta: WebviewClientMeta;
  readonly attachedAt: number;
  readonly subscriptions: Set<string>;
  seq: number;
}

/** 多 Webview client hub：负责 VS Code Webview transport 层的 attach/detach/post/broadcast。 */
export class WebviewHub implements WebviewCapability {
  private readonly clients = new Map<BridgeClientId, WebviewClientEntry>();

  public attach(webview: vscode.Webview, meta: WebviewClientMeta = { kind: 'unknown' }): BridgeClientId {
    const clientId = createClientId(meta);
    this.clients.set(clientId, {
      id: clientId,
      webview,
      meta,
      attachedAt: Date.now(),
      subscriptions: new Set<string>(),
      seq: 0
    });
    return clientId;
  }

  public detach(clientId: BridgeClientId): void {
    this.clients.delete(clientId);
  }

  public detachAll(): void {
    this.clients.clear();
  }

  public subscribe(clientId: BridgeClientId, streamId: string): void {
    this.clients.get(clientId)?.subscriptions.add(streamId);
  }

  public unsubscribe(clientId: BridgeClientId, streamId: string): void {
    this.clients.get(clientId)?.subscriptions.delete(streamId);
  }

  public post(clientId: BridgeClientId, message: ExtensionToWebviewMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    void client.webview.postMessage(prepareOutbound(client, message));
  }

  public broadcast(message: ExtensionToWebviewMessage): void {
    for (const clientId of this.clients.keys()) {
      this.post(clientId, message);
    }
  }

  public broadcastToStream(streamId: string, message: ExtensionToWebviewMessage): void {
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(streamId)) {
        this.post(client.id, message);
      }
    }
  }

  public clientIds(): BridgeClientId[] {
    return [...this.clients.keys()];
  }
}

export function createWebviewCapability(): WebviewCapability {
  return new WebviewHub();
}

function createClientId(meta: WebviewClientMeta): BridgeClientId {
  const prefix = meta.kind === 'mainPanel' ? 'panel' : meta.kind;
  return `${prefix}-${createMessageId()}`;
}

function prepareMessageId(message: ExtensionToWebviewMessage): string {
  return message.id || createMessageId();
}

function prepareOutbound(client: WebviewClientEntry, message: ExtensionToWebviewMessage): ExtensionToWebviewMessage {
  client.seq += 1;
  return {
    ...message,
    id: prepareMessageId(message),
    clientId: client.id,
    seq: client.seq
  } as ExtensionToWebviewMessage;
}
