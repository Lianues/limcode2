export const ChatEventType = {
  Send: 'chat:send',
  Abort: 'chat:abort'
} as const;

export interface ChatSendPayload {
  conversationId: string;
  text: string;
}
export interface ChatAbortPayload {
  conversationId: string;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'chat:send': ChatSendPayload;
    'chat:abort': ChatAbortPayload;
  }
}
