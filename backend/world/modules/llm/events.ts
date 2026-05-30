export const LlmEventType = {
  Delta: 'llm:delta',
  ThoughtDelta: 'llm:thoughtDelta',
  ThoughtDone: 'llm:thoughtDone',
  ToolCall: 'llm:toolcall',
  Done: 'llm:done',
  Error: 'llm:error'
} as const;

export interface LlmDeltaPayload {
  requestId: string;
  text: string;
}
export interface LlmThoughtDeltaPayload {
  requestId: string;
  text: string;
  thoughtSignature?: string;
}
export interface LlmThoughtDonePayload {
  requestId: string;
  thoughtDurationMs: number;
  thoughtSignature?: string;
}
export interface LlmToolCallPayload {
  requestId: string;
  calls: Array<{ id?: string; name: string; argsJson: string; thoughtSignature?: string }>;
}
export interface LlmDonePayload {
  requestId: string;
  createdAt?: number;
  streamOutputDurationMs?: number;
}
export interface LlmErrorPayload {
  requestId: string;
  message: string;
  createdAt?: number;
  streamOutputDurationMs?: number;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'llm:delta': LlmDeltaPayload;
    'llm:thoughtDelta': LlmThoughtDeltaPayload;
    'llm:thoughtDone': LlmThoughtDonePayload;
    'llm:toolcall': LlmToolCallPayload;
    'llm:done': LlmDonePayload;
    'llm:error': LlmErrorPayload;
  }
}
