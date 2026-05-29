import type { EffectOutbox } from '../world/effects';
import type { RuntimeEnv, Emit } from './RuntimeEnv';
import type { EffectHandlerRegistry } from './bindings';

export function flushEffects(outbox: EffectOutbox, env: RuntimeEnv, emit: Emit, handlers: EffectHandlerRegistry): void {
  for (const effect of outbox.drain()) {
    handlers.execute(effect, env, emit);
  }
}
