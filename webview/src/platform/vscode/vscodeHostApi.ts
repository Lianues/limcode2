import type { HostApi } from '../hostApi';

type VscodeHostWindow = Window & typeof globalThis & {
  __limcodeVsCodeApi?: VsCodeApi;
};

/** 当前是否运行在 VS Code Webview 宿主中。 */
export function isVscodeHost(): boolean {
  return typeof window.acquireVsCodeApi === 'function';
}

/** 基于 VS Code Webview API 实现的 HostApi。这里是唯一直接接触 acquireVsCodeApi 的地方。 */
export function createVscodeHostApi(): HostApi {
  const vscode = getVsCodeApi();

  return {
    postMessage(message: unknown): void {
      vscode.postMessage(message);
    },
    onMessage(handler: (message: unknown) => void): () => void {
      const listener = (event: MessageEvent<unknown>): void => handler(event.data);
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
    getState<TState>(): TState | undefined {
      return vscode.getState() as TState | undefined;
    },
    setState<TState>(state: TState): void {
      vscode.setState(state);
    }
  };
}

function getVsCodeApi(): VsCodeApi {
  const limcodeWindow = window as VscodeHostWindow;
  // acquireVsCodeApi 在同一个 Webview session 里只能调用一次。
  // Vite HMR 会重新执行模块，所以必须缓存，否则热更新后会直接抛错导致空白页。
  limcodeWindow.__limcodeVsCodeApi ??= window.acquireVsCodeApi!();
  return limcodeWindow.__limcodeVsCodeApi;
}
