import type { LlmStartRequest } from './contracts';

export interface LlmStartEffect {
  kind: 'llm.start';
  request: LlmStartRequest;
}

export interface LlmAbortEffect {
  kind: 'llm.abort';
  requestId: string;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'llm.start': LlmStartEffect;
    'llm.abort': LlmAbortEffect;
  }
}
