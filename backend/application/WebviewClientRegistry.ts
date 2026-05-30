import type { BridgeClientId, WebviewClientMeta } from '../../shared/protocol';

export interface WebviewClientRegistration {
  meta: WebviewClientMeta;
  attachedAt: number;
}

const UNKNOWN_CLIENT_META: WebviewClientMeta = { kind: 'unknown' };

/**
 * 记录 extension host 已接入的 Webview client 元信息。
 * 真实 vscode.Webview 句柄仍由 WebviewCapability 管理。
 */
export class WebviewClientRegistry {
  private readonly clients = new Map<BridgeClientId, WebviewClientRegistration>();

  public register(clientId: BridgeClientId, meta: WebviewClientMeta = UNKNOWN_CLIENT_META): void {
    this.clients.set(clientId, { meta, attachedAt: Date.now() });
  }

  public unregister(clientId: BridgeClientId): void {
    this.clients.delete(clientId);
  }

  public clear(): void {
    this.clients.clear();
  }

  public get(clientId: BridgeClientId): WebviewClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  public getOrUnknown(clientId: BridgeClientId): WebviewClientRegistration {
    return this.get(clientId) ?? { meta: UNKNOWN_CLIENT_META, attachedAt: Date.now() };
  }
}
