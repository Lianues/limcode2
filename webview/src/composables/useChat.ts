import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from '@webview/stores/useClientStateStore';

/** 对话相关的出站动作收口，组件通过它发送消息而不直接接触 bridge。 */
export function useChat() {
  const clientState = useClientStateStore();

  function sendMessage(text: string): boolean {
    const conversationId = clientState.currentConversationId;
    const trimmed = text.trim();
    if (!trimmed || !conversationId) return false;
    bridge.request(BridgeMessageType.ChatSend, { conversationId, text: trimmed });
    return true;
  }

  return { sendMessage };
}
