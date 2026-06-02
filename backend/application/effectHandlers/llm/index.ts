import type { EffectHandlerRegistry } from '../registry';

export function registerLlmEffectHandlers(registry: EffectHandlerRegistry): void {
  registry.register('llm.start', (effect, env, emit) => {
    env.llm.start(effect.request, emit);
  });

  registry.register('llm.abort', (effect, env) => {
    env.llm.abort(effect.requestId);
  });
}
