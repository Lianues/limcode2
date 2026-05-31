import type { ToolCallEventKind, ToolCallStatus } from '../../../../shared/protocol';

export const ToolEventType = {
  State: 'tool:state',
  ExecuteRequested: 'tool:executeRequested'
} as const;

export interface ToolExecuteRequestedPayload {
  toolCallId: string;
  conversationId?: string;
}

export interface ToolStatePayload {
  toolCallId: string;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  progress?: unknown;
  eventKind?: ToolCallEventKind;
  delta?: string;
  durationMs?: number;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'tool:state': ToolStatePayload;
    'tool:executeRequested': ToolExecuteRequestedPayload;
  }
}
