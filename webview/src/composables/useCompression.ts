import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import type { CompressionBlockRecord } from '@shared/protocol';

export function useCompression() {
  const clientState = useClientStateStore();

  function createCompression(methodConfigId?: string): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId) return false;
    if (clientState.currentCompressionBlocks.some((block) => block.status === 'pending' || block.status === 'running')) {
      bridge.request(BridgeMessageType.ShowInfo, { message: '上下文正在压缩，请等待完成后再发起新的压缩。' });
      return false;
    }
    if (clientState.currentMessages.some((message) => message.status === 'streaming')) {
      bridge.request(BridgeMessageType.ShowInfo, { message: '请等待 AI 响应结束后再压缩上下文。' });
      return false;
    }
    if (clientState.currentMessages.length < 2) return false;
    bridge.request(BridgeMessageType.CompressionCreate, { conversationId, ...(methodConfigId ? { methodConfigId } : {}) });
    return true;
  }

  function deleteCompression(block: CompressionBlockRecord): void {
    bridge.request(BridgeMessageType.CompressionDelete, { conversationId: block.conversationId, blockId: block.id });
  }

  function regenerateCompression(block: CompressionBlockRecord): void {
    bridge.request(BridgeMessageType.CompressionRegenerate, { conversationId: block.conversationId, blockId: block.id, ...(block.methodConfigId ? { methodConfigId: block.methodConfigId } : {}) });
  }

  function setCompressionEnabled(block: CompressionBlockRecord, enabled: boolean): void {
    bridge.request(enabled ? BridgeMessageType.CompressionEnable : BridgeMessageType.CompressionDisable, { conversationId: block.conversationId, blockId: block.id });
  }

  return { createCompression, deleteCompression, regenerateCompression, setCompressionEnabled };
}
