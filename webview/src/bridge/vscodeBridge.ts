import {
  BridgeMessageType,
  createMessageId,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage
} from '@shared/protocol';

type ExtensionMessageListener<T extends ExtensionToWebviewMessage = ExtensionToWebviewMessage> = (
  message: T
) => void;

type LimCodeWindow = Window & typeof globalThis & {
  __limcodeVsCodeApi?: VsCodeApi;
  __limcodeBridge?: VscodeBridge;
};

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

function getOrCreateBridge(): VscodeBridge {
  const limcodeWindow = window as LimCodeWindow;
  limcodeWindow.__limcodeBridge ??= new VscodeBridge();
  return limcodeWindow.__limcodeBridge;
}

function getVsCodeApi(): VsCodeApi {
  const limcodeWindow = window as LimCodeWindow;
  if (limcodeWindow.__limcodeVsCodeApi) {
    return limcodeWindow.__limcodeVsCodeApi;
  }

  if (typeof window.acquireVsCodeApi === 'function') {
    // acquireVsCodeApi 在同一个 Webview session 里只能调用一次。
    // Vite HMR 会重新执行模块，所以必须缓存起来，否则热更新后会直接抛错导致空白页。
    limcodeWindow.__limcodeVsCodeApi = window.acquireVsCodeApi();
    return limcodeWindow.__limcodeVsCodeApi;
  }

  // 方便直接用 Vite 打开前端调试；在真正 VS Code Webview 内会走上面的 acquireVsCodeApi。
  limcodeWindow.__limcodeVsCodeApi = {
    postMessage: (message: unknown) => {
      console.debug('[mock vscode api] postMessage:', message);
    },
    getState: () => undefined,
    setState: () => undefined
  };
  return limcodeWindow.__limcodeVsCodeApi;
}

export const bridge = getOrCreateBridge();
export { BridgeMessageType };
