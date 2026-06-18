import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useAgentStore } from '@webview/stores/useAgentStore';
import type { MessageContent } from '@shared/protocol';

/** 对话相关的出站动作收口，组件通过它发送消息而不直接接触 bridge。 */
export function useChat() {
  const clientState = useClientStateStore();
  const agentStore = useAgentStore();

  function sendMessage(text: string, content?: MessageContent): boolean {
    const conversationId = clientState.currentConversationId;
    const trimmed = text.trim();
    if (!trimmed || !conversationId) return false;
    const agentId = agentStore.activeAgentForConversation(conversationId)?.id;
    bridge.request(BridgeMessageType.ChatSend, { conversationId, text: trimmed, ...(content ? { content } : {}), ...(agentId ? { agentId } : {}) });
    return true;
  }

  function editMessage(conversationId: string, messageId: string, text: string, options: { runAfterEdit?: boolean; deleteFollowing?: boolean } = {}): boolean {
    const trimmed = text.trim();
    if (!conversationId || !messageId || !trimmed) return false;
    bridge.request(BridgeMessageType.MessageEdit, { conversationId, messageId, text: trimmed, ...options });
    return true;
  }

  function retryMessageFrom(conversationId: string, messageId: string): boolean {
    if (!conversationId || !messageId) return false;
    bridge.request(BridgeMessageType.MessageRetryFrom, { conversationId, messageId });
    return true;
  }

  function deleteMessagesFrom(conversationId: string, messageId: string): boolean {
    if (!conversationId || !messageId) return false;
    bridge.request(BridgeMessageType.MessageDeleteFrom, { conversationId, messageId });
    return true;
  }

  function abortCurrentConversation(reason = 'user_requested_abort'): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId) return false;
    void reason;
    bridge.request(BridgeMessageType.ChatAbort, { conversationId });
    return true;
  }

  return { sendMessage, editMessage, retryMessageFrom, deleteMessagesFrom, abortCurrentConversation };
}
