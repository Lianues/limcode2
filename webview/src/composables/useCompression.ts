import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import type { CompressionBlockRecord, ConversationTimelineChunkSummaryRecord, LlmProviderConfigRecord } from '@shared/protocol';

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
    if (!conversationId) {
      logCompressionClientAction('create.skipNoConversation', { input });
      return false;
    }
    const runningBlocks = conversationTimeline.currentCompressionBlocks.filter((block) => block.status === 'pending' || block.status === 'running');
    if (runningBlocks.length > 0) {
      logCompressionClientAction('create.cancelRunningBlocks', {
        conversationId,
        blockIds: runningBlocks.map((block) => block.id)
      });
      for (const block of runningBlocks) deleteCompression(block);
      return true;
    }
    const currentMessages = conversationTimeline.currentMessages;
    if (currentMessages.some((message) => message.status === 'streaming')) {
      logCompressionClientAction('create.skipStreamingMessage', compressionTimelineDebugContext(conversationId, input));
      bridge.request(BridgeMessageType.ShowInfo, { message: '请等待 AI 响应结束后再压缩上下文。' });
      return false;
    }
    const minimumMessageCount = input.startMessageId || input.endMessageId ? 1 : 2;
    if (currentMessages.length < minimumMessageCount) {
      logCompressionClientAction('create.skipInsufficientMessages', {
        ...compressionTimelineDebugContext(conversationId, input),
        minimumMessageCount
      });
      return false;
    }
    const methodKind = activeCompressionConfigForConversation(conversationId)?.kind;
    const payload = {
      conversationId,
      ...(input.startMessageId ? { startMessageId: input.startMessageId } : {}),
      ...(input.endMessageId ? { endMessageId: input.endMessageId } : {}),
      ...(input.methodConfigId ? { methodConfigId: input.methodConfigId } : {}),
      ...(methodKind ? { methodKind } : {})
    };
    const requestId = bridge.request(BridgeMessageType.CompressionCreate, payload);
    logCompressionClientAction('create.requestSent', {
      requestId,
      payload,
      ...compressionTimelineDebugContext(conversationId, input)
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
    const modelId = selectedModelIdForProvider(activeProvider, conversationId);
    const modelBinding = activeProviderConfigId && modelId
      ? globalSettings.llmCompression.modelBindings.find((item) => item.providerConfigId === activeProviderConfigId && item.modelId === modelId)
      : undefined;
    const binding = activeProviderConfigId
      ? globalSettings.llmCompression.providerBindings.find((item) => item.providerConfigId === activeProviderConfigId)
      : undefined;
    const configId = modelBinding?.compressionConfigId ?? binding?.compressionConfigId ?? globalSettings.llmCompression.defaultConfigId;
    return globalSettings.llmCompressionConfigs.configs.find((config) => config.id === configId)
      ?? globalSettings.llmCompressionConfigs.configs[0];
  }

  function selectedModelIdForProvider(config: LlmProviderConfigRecord | undefined, conversationId: string): string {
    if (!config) return '';
    const conversationOverride = conversationSettings.llm.conversationId === conversationId
      ? conversationSettings.llm.modelOverrides?.[config.id]?.trim()
      : '';
    if (conversationOverride && modelExistsInProvider(config, conversationOverride)) return conversationOverride;
    return config.model?.trim() ?? '';
  }

  function modelExistsInProvider(config: LlmProviderConfigRecord, modelId: string): boolean {
    const id = modelId.trim();
    if (!id) return false;
    return config.model?.trim() === id || config.models.some((candidate) => candidate.id.trim() === id);
  }

  function compressionTimelineDebugContext(conversationId: string, input: CreateCompressionOptions): Record<string, unknown> {
    const timeline = conversationTimeline.currentTimeline;
    const chunks = timeline.loadedChunkIds
      .map((id) => timeline.chunkById[id])
      .filter((chunk): chunk is ConversationTimelineChunkSummaryRecord => !!chunk)
      .map((chunk) => ({ id: chunk.id, index: chunk.index, startSeq: chunk.startSeq, endSeq: chunk.endSeq, messageCount: chunk.messageCount }));
    const messages = conversationTimeline.currentMessages;
    return {
      conversationId,
      timelineConversationId: conversationTimeline.currentConversationId,
      input,
      loadedMessageCount: messages.length,
      totalMessages: conversationTimeline.currentTotalMessages,
      hasOlder: conversationTimeline.currentHasOlder,
      hasNewer: conversationTimeline.currentHasNewer,
      firstSeq: messages[0]?.seq,
      lastSeq: messages[messages.length - 1]?.seq,
      loadedChunks: chunks
    };
  }

  return { createCompression, deleteCompression, regenerateCompression, setCompressionEnabled };
}

function logCompressionClientAction(stage: string, payload: Record<string, unknown>): void {
  console.info('[LimCode][Compression][Webview]', stage, payload);
}
