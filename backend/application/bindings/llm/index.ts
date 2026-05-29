import type { EffectHandlerRegistry } from '../registry';

export function registerLlmBindings(registry: EffectHandlerRegistry): void {
  registry.register('llm.start', (effect, env, emit) => {
    env.llm.start(effect.request, emit);
  });
}
