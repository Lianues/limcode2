export const LlmEventType = {
  Delta: 'llm:delta',
  Thought: 'llm:thought',
  ToolCall: 'llm:toolcall',
  Done: 'llm:done',
  Error: 'llm:error'
} as const;

export interface LlmDeltaPayload {
  requestId: string;
  text: string;
}
export interface LlmThoughtPayload {
  requestId: string;
  text: string;
  thoughtDurationMs: number;
  thoughtSignature?: string;
  thoughtSignatures?: Record<string, string | undefined>;
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
    'llm:thought': LlmThoughtPayload;
    'llm:toolcall': LlmToolCallPayload;
    'llm:done': LlmDonePayload;
    'llm:error': LlmErrorPayload;
  }
}
