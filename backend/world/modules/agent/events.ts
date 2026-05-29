export const AgentEventType = {
  SpawnRequested: 'agent:spawnRequested'
} as const;

export interface AgentSpawnRequestedPayload {
  requestEntity: number;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'agent:spawnRequested': AgentSpawnRequestedPayload;
  }
}
