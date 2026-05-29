export const ToolEventType = {
  Done: 'tool:done'
} as const;

export interface ToolDonePayload {
  toolCallId: string;
  ok: boolean;
  output: string;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'tool:done': ToolDonePayload;
  }
}
