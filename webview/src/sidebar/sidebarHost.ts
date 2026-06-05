import { createHostApi } from '@webview/platform/createHostApi';
import type { ExtensionToSidebarMessage, SidebarToExtensionMessage } from './types';

const host = createHostApi();

export function postSidebarMessage(message: SidebarToExtensionMessage): void {
  host.postMessage(message);
}

export function onSidebarMessage(handler: (message: ExtensionToSidebarMessage) => void): () => void {
  return host.onMessage((raw) => handler(raw as ExtensionToSidebarMessage));
}
