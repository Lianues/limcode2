import type { ChatAbortPayload, ChatSendPayload, MessageDeleteFromPayload, MessageEditPayload, MessageRetryFromPayload } from '../../../../shared/protocol';

export const ChatEventType = {
  Send: 'chat:send',
  Abort: 'chat:abort',
  Edit: 'chat:edit',
  DeleteFrom: 'chat:deleteFrom',
  RetryFrom: 'chat:retryFrom'
} as const;

export type ChatSendEventPayload = ChatSendPayload;
export type ChatAbortEventPayload = ChatAbortPayload;
export type ChatEditPayload = MessageEditPayload;
export type ChatDeleteFromPayload = MessageDeleteFromPayload;
export type ChatRetryFromPayload = MessageRetryFromPayload;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'chat:send': ChatSendEventPayload;
    'chat:abort': ChatAbortEventPayload;
    'chat:edit': ChatEditPayload;
    'chat:deleteFrom': ChatDeleteFromPayload;
    'chat:retryFrom': ChatRetryFromPayload;
  }
}
