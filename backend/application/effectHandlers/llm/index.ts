import type { EffectHandlerRegistry } from '../registry';

export function registerLlmEffectHandlers(registry: EffectHandlerRegistry): void {
  registry.register('llm.resolveInvocation', (effect, env, emit) => {
    env.llm.resolveInvocation(effect, emit);
  });

  registry.register('llm.start', (effect, env, emit) => {
    env.llm.start(effect.request, emit);
  });

  registry.register('llm.abort', (effect, env) => {
    env.llm.abort(effect.requestId);
  });
}
