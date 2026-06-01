import type { HostApi } from './hostApi';
import { createVscodeHostApi, isVscodeHost } from './vscode';

/**
 * 根据运行环境选择宿主实现。
 *
 * - VS Code Webview：使用 acquireVsCodeApi。
 * - 其它（例如直接用 Vite 打开页面调试）：使用 mock 实现，便于脱离 IDE 调试 UI。
 *
 * 迁移到其它 IDE 时，在这里追加分支即可，上层无需改动。
 */
export function createHostApi(): HostApi {
  if (isVscodeHost()) {
    return createVscodeHostApi();
  }
  return createMockHostApi();
}

function createMockHostApi(): HostApi {
  let mockState: unknown;

  return {
    postMessage(message: unknown): void {
      console.debug('[mock host] postMessage:', message);
    },
    onMessage(handler: (message: unknown) => void): () => void {
      const listener = (event: MessageEvent<unknown>): void => handler(event.data);
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
    getState<TState>(): TState | undefined {
      return mockState as TState | undefined;
    },
    setState<TState>(state: TState): void {
      mockState = state;
    }
  };
}
