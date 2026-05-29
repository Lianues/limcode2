import {
  BridgeMessageType,
  createMessageId,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage
} from '@shared/protocol';

type ExtensionMessageListener<T extends ExtensionToWebviewMessage = ExtensionToWebviewMessage> = (
  message: T
) => void;

class VscodeBridge {
  private readonly vscode = getVsCodeApi();
  private readonly listeners = new Map<string, Set<ExtensionMessageListener>>();

  public constructor() {
    window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const message = event.data;
      this.emit(message);
    });
  }

  public post(message: WebviewToExtensionMessage): void {
    this.vscode.postMessage(message);
  }

  public request<TType extends WebviewToExtensionMessage['type']>(
    type: TType,
    payload?: Extract<WebviewToExtensionMessage, { type: TType }>['payload']
  ): string {
    const id = createMessageId();

    this.post({
      id,
      type,
      payload
    } as Extract<WebviewToExtensionMessage, { type: TType }>);

    return id;
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

  private emit(message: ExtensionToWebviewMessage): void {
    this.listeners.get(message.type)?.forEach((listener) => listener(message));
    this.listeners.get('*')?.forEach((listener) => listener(message));
  }
}

function getVsCodeApi(): VsCodeApi {
  if (typeof window.acquireVsCodeApi === 'function') {
    return window.acquireVsCodeApi();
  }

  // 方便直接用 Vite 打开前端调试；在真正 VS Code Webview 内会走上面的 acquireVsCodeApi。
  return {
    postMessage: (message: unknown) => {
      console.debug('[mock vscode api] postMessage:', message);
    },
    getState: () => undefined,
    setState: () => undefined
  };
}

export const bridge = new VscodeBridge();
export { BridgeMessageType };
