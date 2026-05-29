import type { EffectOutbox, WorldEffect } from '../world/effects';
import type { RuntimeEnv, Emit } from './RuntimeEnv';
import type { EffectHandlerRegistry } from './bindings';

export function flushEffects(outbox: EffectOutbox, env: RuntimeEnv, emit: Emit, handlers: EffectHandlerRegistry): void {
  for (const effect of outbox.drain()) {
    handlers.execute(effect, env, emit);
  }
}

export function flushEffectsWhere(outbox: EffectOutbox, env: RuntimeEnv, emit: Emit, handlers: EffectHandlerRegistry, predicate: (effect: WorldEffect) => boolean): void {
  for (const effect of outbox.drainWhere(predicate)) {
    handlers.execute(effect, env, emit);
  }
}
