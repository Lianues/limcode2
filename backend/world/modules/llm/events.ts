export const LlmEventType = {
  Delta: 'llm:delta',
  ToolCall: 'llm:toolcall',
  Done: 'llm:done',
  Error: 'llm:error'
} as const;

export interface LlmDeltaPayload {
  requestId: string;
  text: string;
}
export interface LlmToolCallPayload {
  requestId: string;
  calls: Array<{ id?: string; name: string; argsJson: string }>;
}
export interface LlmDonePayload {
  requestId: string;
}
export interface LlmErrorPayload {
  requestId: string;
  message: string;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'llm:delta': LlmDeltaPayload;
    'llm:toolcall': LlmToolCallPayload;
    'llm:done': LlmDonePayload;
    'llm:error': LlmErrorPayload;
  }
}
