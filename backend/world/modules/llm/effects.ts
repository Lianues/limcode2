import type { LlmResolveInvocationRequest, LlmStartRequest } from './contracts';

export interface LlmStartEffect {
  kind: 'llm.start';
  request: LlmStartRequest;
}

export interface LlmAbortEffect {
  kind: 'llm.abort';
  requestId: string;
}

export interface LlmResolveInvocationEffect extends LlmResolveInvocationRequest {
  kind: 'llm.resolveInvocation';
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'llm.start': LlmStartEffect;
    'llm.abort': LlmAbortEffect;
    'llm.resolveInvocation': LlmResolveInvocationEffect;
  }
}
