import type { LlmStartRequest } from './contracts';

export interface LlmStartEffect {
  kind: 'llm.start';
  request: LlmStartRequest;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'llm.start': LlmStartEffect;
  }
}
