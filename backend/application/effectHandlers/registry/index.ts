import type { WorldEffect, WorldEffectMap } from '@backend/world/effects';
import type { RuntimeEnv, Emit } from '../../RuntimeEnv';

export type EffectHandler<K extends keyof WorldEffectMap> = (
  effect: WorldEffectMap[K],
  env: RuntimeEnv,
  emit: Emit
) => void;

export class EffectHandlerRegistry {
  private readonly handlers = new Map<string, EffectHandler<keyof WorldEffectMap>>();

  public register<K extends keyof WorldEffectMap>(kind: K, handler: EffectHandler<K>): void {
    this.handlers.set(kind as string, handler as EffectHandler<keyof WorldEffectMap>);
  }

  public execute(effect: WorldEffect, env: RuntimeEnv, emit: Emit): void {
    const handler = this.handlers.get(effect.kind);
    if (!handler) {
      throw new Error(`No effect handler registered for kind: ${effect.kind}`);
    }
    handler(effect as never, env, emit);
  }
}
