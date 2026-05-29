import type { Scheduler } from '../ecs/Scheduler';
import type { World } from '../ecs/types';

export interface WorldInstallContext {
  world: World;
  scheduler: Scheduler;
}

export interface WorldPlugin {
  readonly name: string;
  install(ctx: WorldInstallContext): void;
}

export function installWorldPlugins(ctx: WorldInstallContext, plugins: WorldPlugin[]): void {
  for (const plugin of plugins) {
    plugin.install(ctx);
  }
}
