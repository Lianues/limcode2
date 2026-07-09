export const ClientSyncEventType = {
  Resync: 'client:resync',
  StreamsReleased: 'client:streams-released'
} as const;

export interface ClientResyncPayload {
  streamId?: string;
  conversationId?: string;
}

export interface ClientStreamsReleasedPayload {
  streamIds: string[];
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'client:resync': ClientResyncPayload;
    'client:streams-released': ClientStreamsReleasedPayload;
  }
}
