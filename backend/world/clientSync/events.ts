export const ClientSyncEventType = {
  Resync: 'client:resync'
} as const;

export interface ClientResyncPayload {
  sessionId?: string;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'client:resync': ClientResyncPayload;
  }
}
