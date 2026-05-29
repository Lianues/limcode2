import type * as vscode from 'vscode';
import type { WebviewCapability } from './types';

/** 函数式 Webview capability：内部只保存当前 webview handle，供 RuntimeEnv 使用。 */
export function createWebviewCapability(): WebviewCapability {
  let webview: vscode.Webview | undefined;
  return {
    attach(nextWebview) {
      webview = nextWebview;
    },
    detach() {
      webview = undefined;
    },
    post(message) {
      void webview?.postMessage(message);
    }
  };
}
