export const ChatEventType = {
  Send: 'chat:send',
  Abort: 'chat:abort',
  Edit: 'chat:edit',
  DeleteFrom: 'chat:deleteFrom'
} as const;

export interface ChatSendPayload {
  conversationId: string;
  text: string;
}
export interface ChatAbortPayload {
  conversationId: string;
}
export interface ChatEditPayload {
  conversationId: string;
  messageId: string;
  text: string;
  runAfterEdit?: boolean;
  deleteFollowing?: boolean;
}
export interface ChatDeleteFromPayload {
  conversationId: string;
  messageId: string;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'chat:send': ChatSendPayload;
    'chat:abort': ChatAbortPayload;
    'chat:edit': ChatEditPayload;
    'chat:deleteFrom': ChatDeleteFromPayload;
  }
}
