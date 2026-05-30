import {
  BridgeMessageType,
  createMessageId,
  type BridgeChannel,
  type BridgeClientId,
  type BridgeScope,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage
} from '@shared/protocol';

type ExtensionMessageListener<T extends ExtensionToWebviewMessage = ExtensionToWebviewMessage> = (
  message: T
) => void;

interface BridgePersistedState {
  clientId?: BridgeClientId;
}

type LimCodeWindow = Window & typeof globalThis & {
  __limcodeVsCodeApi?: VsCodeApi<BridgePersistedState>;
  __limcodeBridge?: VscodeBridge;
};

class VscodeBridge {
  private readonly vscode = getVsCodeApi();
  private readonly listeners = new Map<string, Set<ExtensionMessageListener>>();
  private clientId: BridgeClientId | undefined = this.vscode.getState()?.clientId;

  public constructor() {
    window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const message = event.data;
      this.captureTransportState(message);
      this.emit(message);
    });
  }

  public post(message: WebviewToExtensionMessage): void {
    this.vscode.postMessage({
      ...message,
      clientId: this.clientId
    });
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
      this.vscode.setState({ ...(this.vscode.getState() ?? {}), clientId: message.clientId });
    }
  }

  private emit(message: ExtensionToWebviewMessage): void {
    this.listeners.get(message.type)?.forEach((listener) => listener(message));
    this.listeners.get('*')?.forEach((listener) => listener(message));
  }
}

function channelForType(type: WebviewToExtensionMessage['type']): BridgeChannel {
  switch (type) {
    case BridgeMessageType.ChatSend:
    case BridgeMessageType.ChatAbort:
      return 'command';
    case BridgeMessageType.ClientResync:
      return 'state';
    case BridgeMessageType.GlobalSettingsGet:
    case BridgeMessageType.GlobalSettingsUpdate:
    case BridgeMessageType.ConversationSettingsGet:
    case BridgeMessageType.ConversationSettingsUpdate:
      return 'settings';
    default:
      return 'control';
  }
}

function getOrCreateBridge(): VscodeBridge {
  const limcodeWindow = window as LimCodeWindow;
  limcodeWindow.__limcodeBridge ??= new VscodeBridge();
  return limcodeWindow.__limcodeBridge;
}

function getVsCodeApi(): VsCodeApi<BridgePersistedState> {
  const limcodeWindow = window as LimCodeWindow;
  if (limcodeWindow.__limcodeVsCodeApi) {
    return limcodeWindow.__limcodeVsCodeApi;
  }

  if (typeof window.acquireVsCodeApi === 'function') {
    // acquireVsCodeApi 在同一个 Webview session 里只能调用一次。
    // Vite HMR 会重新执行模块，所以必须缓存起来，否则热更新后会直接抛错导致空白页。
    limcodeWindow.__limcodeVsCodeApi = window.acquireVsCodeApi<BridgePersistedState>();
    return limcodeWindow.__limcodeVsCodeApi;
  }

  // 方便直接用 Vite 打开前端调试；在真正 VS Code Webview 内会走上面的 acquireVsCodeApi。
  let mockState: BridgePersistedState | undefined;
  limcodeWindow.__limcodeVsCodeApi = {
    postMessage: (message: unknown) => {
      console.debug('[mock vscode api] postMessage:', message);
    },
    getState: () => mockState,
    setState: (state: BridgePersistedState) => {
      mockState = state;
    }
  };
  return limcodeWindow.__limcodeVsCodeApi;
}

export const bridge = getOrCreateBridge();
export { BridgeMessageType };
