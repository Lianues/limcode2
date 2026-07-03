import type { LlmInvocationSettingsSnapshotRecord, LlmRawErrorInfoRecord, LlmUsageMetadataRecord } from '../../../../shared/protocol';
import type { LlmCompactResult } from './contracts';

export const LlmEventType = {
  InvocationResolved: 'llm:invocationResolved',
  InvocationResolveError: 'llm:invocationResolveError',
  Started: 'llm:started',
  Delta: 'llm:delta',
  ThoughtDelta: 'llm:thoughtDelta',
  ThoughtProgress: 'llm:thoughtProgress',
  ThoughtDone: 'llm:thoughtDone',
  ToolCall: 'llm:toolcall',
  Done: 'llm:done',
  Error: 'llm:error',
  RetryScheduled: 'llm:retryScheduled',
  RetryStarted: 'llm:retryStarted',
  RetryCancelled: 'llm:retryCancelled',
  RetryRecovered: 'llm:retryRecovered',
  CompactDone: 'llm:compactDone',
  CompactError: 'llm:compactError'
} as const;

export interface LlmStartedPayload {
  requestId: string;
  invocationId?: string;
  model?: string;
  startedAt?: number;
}
export interface LlmInvocationResolvedPayload {
  invocationId: string;
  requestId: string;
  settings: LlmInvocationSettingsSnapshotRecord;
  resolvedAt: number;
}
export interface LlmInvocationResolveErrorPayload {
  invocationId: string;
  requestId: string;
  message: string;
  resolvedAt: number;
}
export interface LlmDeltaPayload {
  requestId: string;
  text: string;
}
export interface LlmThoughtDeltaPayload {
  requestId: string;
  text: string;
  thoughtSignature?: string;
  thoughtElapsedMs?: number;
}
export interface LlmThoughtProgressPayload {
  requestId: string;
  thoughtElapsedMs: number;
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
  usageMetadata?: LlmUsageMetadataRecord;
}
export interface LlmErrorPayload {
  requestId: string;
  message: string;
  rawError?: LlmRawErrorInfoRecord;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  createdAt?: number;
  streamOutputDurationMs?: number;
}
export interface LlmRetryPayload {
  requestId: string;
  message: string;
  rawError?: LlmRawErrorInfoRecord;
  retryAttempt: number;
  retryMaxAttempts: number;
  retryDelayMs?: number;
  createdAt: number;
}
export interface LlmCompactDonePayload {
  requestId: string;
  blockId: string;
  conversationId: string;
  result: LlmCompactResult;
  completedAt: number;
}
export interface LlmCompactErrorPayload {
  requestId: string;
  blockId: string;
  conversationId: string;
  message: string;
  completedAt: number;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'llm:invocationResolved': LlmInvocationResolvedPayload;
    'llm:invocationResolveError': LlmInvocationResolveErrorPayload;
    'llm:started': LlmStartedPayload;
    'llm:delta': LlmDeltaPayload;
    'llm:thoughtDelta': LlmThoughtDeltaPayload;
    'llm:thoughtProgress': LlmThoughtProgressPayload;
    'llm:thoughtDone': LlmThoughtDonePayload;
    'llm:toolcall': LlmToolCallPayload;
    'llm:done': LlmDonePayload;
    'llm:error': LlmErrorPayload;
    'llm:retryScheduled': LlmRetryPayload;
    'llm:retryStarted': LlmRetryPayload;
    'llm:retryCancelled': LlmRetryPayload;
    'llm:retryRecovered': LlmRetryPayload;
    'llm:compactDone': LlmCompactDonePayload;
    'llm:compactError': LlmCompactErrorPayload;
  }
}
