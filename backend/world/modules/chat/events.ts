export const ChatEventType = {
  Send: 'chat:send',
  Abort: 'chat:abort'
} as const;

export interface ChatSendPayload {
  sessionId: string;
  text: string;
}
export interface ChatAbortPayload {
  sessionId: string;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'chat:send': ChatSendPayload;
    'chat:abort': ChatAbortPayload;
  }
}
