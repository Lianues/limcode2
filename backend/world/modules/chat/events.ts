import type { ChatSendPayload, MessageDeleteFromPayload, MessageEditPayload, MessageRetryFromPayload } from '../../../../shared/protocol';

export const ChatEventType = {
  Send: 'chat:send',
  Edit: 'chat:edit',
  DeleteFrom: 'chat:deleteFrom',
  RetryFrom: 'chat:retryFrom',
  ConversationPanelPresenceChanged: 'chat:conversationPanelPresenceChanged'
} as const;

export type ChatSendEventPayload = ChatSendPayload;
export type ChatEditPayload = MessageEditPayload;
export type ChatDeleteFromPayload = MessageDeleteFromPayload;
export type ChatRetryFromPayload = MessageRetryFromPayload;
export interface ConversationPanelPresenceChangedPayload {
  conversationId: string;
  open: boolean;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'chat:send': ChatSendEventPayload;
    'chat:edit': ChatEditPayload;
    'chat:deleteFrom': ChatDeleteFromPayload;
    'chat:retryFrom': ChatRetryFromPayload;
    'chat:conversationPanelPresenceChanged': ConversationPanelPresenceChangedPayload;
  }
}
