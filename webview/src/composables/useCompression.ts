import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import type { CompressionBlockRecord } from '@shared/protocol';

export interface CreateCompressionOptions {
  startMessageId?: string;
  endMessageId?: string;
  methodConfigId?: string;
}

export function useCompression() {
  const clientState = useClientStateStore();
  const conversationTimeline = useConversationTimelineStore();
  const globalSettings = useGlobalSettingsStore();
  const conversationSettings = useConversationSettingsStore();

  function createCompression(options: CreateCompressionOptions | string = {}): boolean {
    const input = typeof options === 'string' ? { methodConfigId: options } : options;
    const conversationId = clientState.currentConversationId;
    if (!conversationId) return false;
    const runningBlocks = conversationTimeline.currentCompressionBlocks.filter((block) => block.status === 'pending' || block.status === 'running');
    if (runningBlocks.length > 0) {
      for (const block of runningBlocks) deleteCompression(block);
      return true;
    }
    if (conversationTimeline.currentMessages.some((message) => message.status === 'streaming')) {
      bridge.request(BridgeMessageType.ShowInfo, { message: '请等待 AI 响应结束后再压缩上下文。' });
      return false;
    }
    const minimumMessageCount = input.startMessageId || input.endMessageId ? 1 : 2;
    if (conversationTimeline.currentMessages.length < minimumMessageCount) return false;
    const methodKind = activeCompressionConfigForConversation(conversationId)?.kind;
    bridge.request(BridgeMessageType.CompressionCreate, {
      conversationId,
      ...(input.startMessageId ? { startMessageId: input.startMessageId } : {}),
      ...(input.endMessageId ? { endMessageId: input.endMessageId } : {}),
      ...(input.methodConfigId ? { methodConfigId: input.methodConfigId } : {}),
      ...(methodKind ? { methodKind } : {})
    });
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

  function activeCompressionConfigForConversation(conversationId: string) {
    const providerConfigId = conversationSettings.llm.conversationId === conversationId
      ? conversationSettings.llm.activeProviderConfigId
      : '';
    const activeProvider = globalSettings.llmProviderConfigs.configs.find((config) => config.id === providerConfigId)
      ?? globalSettings.llmProviderConfigs.configs.find((config) => config.id === globalSettings.llm.activeProviderConfigId)
      ?? globalSettings.llmProviderConfigs.configs[0];
    const activeProviderConfigId = activeProvider?.id;
    const binding = activeProviderConfigId
      ? globalSettings.llmCompression.providerBindings.find((item) => item.providerConfigId === activeProviderConfigId)
      : undefined;
    const configId = binding?.compressionConfigId ?? globalSettings.llmCompression.defaultConfigId;
    return globalSettings.llmCompressionConfigs.configs.find((config) => config.id === configId)
      ?? globalSettings.llmCompressionConfigs.configs[0];
  }

  return { createCompression, deleteCompression, regenerateCompression, setCompressionEnabled };
}
