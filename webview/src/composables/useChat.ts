import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useAgentStore } from '@webview/stores/useAgentStore';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import type { ChatModelOverrideRecord, MessageContent } from '@shared/protocol';

/** 对话相关的出站动作收口，组件通过它发送消息而不直接接触 bridge。 */
export function useChat() {
  const clientState = useClientStateStore();
  const agentStore = useAgentStore();
  const conversationSettings = useConversationSettingsStore();
  const globalSettings = useGlobalSettingsStore();
  const modelProfileStore = useModelProfileStore();

  function sendMessage(text: string, content?: MessageContent): boolean {
    const conversationId = clientState.currentConversationId;
    const trimmed = text.trim();
    if ((!trimmed && !content?.parts?.length) || !conversationId) return false;
    const agentId = agentStore.activeAgentForConversation(conversationId)?.id;
    const model = currentConversationModelOverride(conversationId);
    const payload = { conversationId, text: trimmed, ...(content?.parts?.length ? { content } : {}), ...(agentId ? { agentId } : {}), ...(model ? { model } : {}) };
    bridge.request(BridgeMessageType.ChatSend, payload);
    return true;
  }

  function editMessage(conversationId: string, messageId: string, text: string, options: { runAfterEdit?: boolean; deleteFollowing?: boolean } = {}): boolean {
    const trimmed = text.trim();
    if (!conversationId || !messageId || !trimmed) return false;
    const model = currentConversationModelOverride(conversationId);
    const payload = { conversationId, messageId, text: trimmed, ...options, ...(model ? { model } : {}) };
    bridge.request(BridgeMessageType.MessageEdit, payload);
    return true;
  }

  function retryMessageFrom(conversationId: string, messageId: string): boolean {
    if (!conversationId || !messageId) return false;
    const model = currentConversationModelOverride(conversationId);
    const payload = { conversationId, messageId, ...(model ? { model } : {}) };
    bridge.request(BridgeMessageType.MessageRetryFrom, payload);
    return true;
  }

  function deleteMessagesFrom(conversationId: string, messageId: string): boolean {
    if (!conversationId || !messageId) return false;
    const payload = { conversationId, messageId };
    bridge.request(BridgeMessageType.MessageDeleteFrom, payload);
    return true;
  }

  function forkConversationFrom(sourceConversationId: string, messageId: string): boolean {
    if (!sourceConversationId || !messageId) return false;
    bridge.request(BridgeMessageType.ConversationFork, { sourceConversationId, messageId });
    return true;
  }

  function cancelLlmAutoRetry(input: { requestId: string; conversationId?: string; messageId?: string; runId?: string }): boolean {
    if (!input.requestId) return false;
    bridge.request(BridgeMessageType.LlmRetryCancel, { ...input, reason: 'user_cancelled_auto_retry' });
    return true;
  }

  function abortCurrentConversation(reason = 'user_requested_abort'): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId) return false;
    void reason;
    bridge.request(BridgeMessageType.ChatAbort, { conversationId });
    return true;
  }

  function removeQueueRun(runId: string): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId || !runId) return false;
    bridge.request(BridgeMessageType.QueueRemove, { runId, conversationId });
    return true;
  }

  function promoteQueueRun(runId: string): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId || !runId) return false;
    bridge.request(BridgeMessageType.QueuePromote, { conversationId, runId });
    return true;
  }

  function reorderQueue(runIds: string[]): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId || runIds.length === 0) return false;
    bridge.request(BridgeMessageType.QueueReorder, { conversationId, runIds });
    return true;
  }

  function pauseQueueRun(runId: string): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId || !runId) return false;
    bridge.request(BridgeMessageType.QueuePause, { conversationId, runId });
    return true;
  }

  function resumeQueueRun(runId: string): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId || !runId) return false;
    bridge.request(BridgeMessageType.QueueResume, { conversationId, runId });
    return true;
  }

  function resumeAllQueueRuns(): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId) return false;
    bridge.request(BridgeMessageType.QueueResumeAll, { conversationId });
    return true;
  }

  function updateQueueInput(runId: string, text: string, content?: MessageContent): boolean {
    const conversationId = clientState.currentConversationId;
    const trimmed = text.trim();
    if (!conversationId || !runId || (!trimmed && !content?.parts?.length)) return false;
    bridge.request(BridgeMessageType.QueueInputUpdate, { conversationId, runId, text: trimmed, ...(content?.parts?.length ? { content } : {}) });
    return true;
  }

  function currentConversationModelOverride(conversationId: string): ChatModelOverrideRecord | undefined {
    const llm = conversationSettings.llm.conversationId === conversationId ? conversationSettings.llm : undefined;
    const profile = modelProfileStore.localProfileFor('conversation', conversationId).profile;
    const configId = llm?.activeProviderConfigId || profile?.providerConfigId?.trim() || globalSettings.llm.activeProviderConfigId || globalSettings.activeLlmProviderConfig?.id || '';
    const config = globalSettings.llmProviderConfigs.configs.find((candidate) => candidate.id === configId) ?? globalSettings.activeLlmProviderConfig;
    if (!config) return undefined;
    const override = llm?.modelOverrides?.[config.id]?.trim();
    const profileModel = profile?.providerConfigId?.trim() === config.id ? profile.model.trim() : '';
    const model = override && modelExistsInConfig(config, override)
      ? override
      : profileModel && modelExistsInConfig(config, profileModel)
        ? profileModel
        : config.model?.trim();
    if (!model) return undefined;
    return { providerConfigId: config.id, provider: config.provider, model };
  }

  function modelExistsInConfig(config: { model?: string; models: Array<{ id: string }> }, modelId: string): boolean {
    const id = modelId.trim();
    if (!id) return false;
    return config.model?.trim() === id || config.models.some((model) => model.id === id);
  }

  return { sendMessage, editMessage, retryMessageFrom, deleteMessagesFrom, forkConversationFrom, cancelLlmAutoRetry, abortCurrentConversation, removeQueueRun, promoteQueueRun, reorderQueue, pauseQueueRun, resumeQueueRun, resumeAllQueueRuns, updateQueueInput };
}
