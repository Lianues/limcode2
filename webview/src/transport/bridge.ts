import {
  BridgeMessageType,
  createMessageId,
  type BridgeChannel,
  type BridgeClientId,
  type BridgeScope,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage
} from '@shared/protocol';
import type { HostApi } from '../platform/hostApi';
import { channelForType } from './channels';

type ExtensionMessageListener<T extends ExtensionToWebviewMessage = ExtensionToWebviewMessage> = (
  message: T
) => void;

interface BridgePersistedState {
  clientId?: BridgeClientId;
}

/**
 * IDE 无关的协议桥。
 *
 * 只依赖 HostApi 收发原始消息，自身负责：clientId 捕获/附带、按类型选通道、
 * request/on/onAny/ready 等协议级能力。不直接接触任何具体 IDE API。
 */
export class Bridge {
  private readonly listeners = new Map<string, Set<ExtensionMessageListener>>();
  private clientId: BridgeClientId | undefined;

  public constructor(private readonly host: HostApi) {
    this.clientId = this.host.getState<BridgePersistedState>()?.clientId;
    this.host.onMessage((raw) => {
      const message = raw as ExtensionToWebviewMessage;
      this.captureTransportState(message);
      this.emit(message);
    });
  }

  public post(message: WebviewToExtensionMessage): void {
    this.host.postMessage({ ...message, clientId: this.clientId });
  }

  public request<TType extends WebviewToExtensionMessage['type']>(
    type: TType,
    payload?: Extract<WebviewToExtensionMessage, { type: TType }>['payload'],
    options: { channel?: BridgeChannel; scope?: BridgeScope; correlationId?: string } = {}
  ): string {
    const id = createMessageId();

    this.post({
      id,
      type,
      channel: options.channel ?? channelForType(type),
      scope: options.scope,
      correlationId: options.correlationId,
      payload
    } as Extract<WebviewToExtensionMessage, { type: TType }>);

    return id;
  }

  public ready(): string {
    return this.request(BridgeMessageType.Ready, undefined, { channel: 'control' });
  }

  public on<TType extends ExtensionToWebviewMessage['type']>(
    type: TType,
    listener: (message: Extract<ExtensionToWebviewMessage, { type: TType }>) => void
  ): () => void {
    const bucket = this.listeners.get(type) ?? new Set<ExtensionMessageListener>();
    bucket.add(listener as ExtensionMessageListener);
    this.listeners.set(type, bucket);

    return () => {
      bucket.delete(listener as ExtensionMessageListener);
    };
  }

  public onAny(listener: ExtensionMessageListener): () => void {
    const bucket = this.listeners.get('*') ?? new Set<ExtensionMessageListener>();
    bucket.add(listener);
    this.listeners.set('*', bucket);

    return () => {
      bucket.delete(listener);
    };
  }

  private captureTransportState(message: ExtensionToWebviewMessage): void {
    if (message.clientId && message.clientId !== this.clientId) {
      this.clientId = message.clientId;
      this.host.setState<BridgePersistedState>({
        ...(this.host.getState<BridgePersistedState>() ?? {}),
        clientId: message.clientId
      });
    }
  }

  private emit(message: ExtensionToWebviewMessage): void {
    this.listeners.get(message.type)?.forEach((listener) => listener(message));
    this.listeners.get('*')?.forEach((listener) => listener(message));
  }
}
