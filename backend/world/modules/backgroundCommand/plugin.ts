import type { WorldPlugin } from '../../plugin';
import { registerBackgroundCommandSystems } from './systems';

export function backgroundCommandPlugin(): WorldPlugin {
  return {
    name: 'backgroundCommand',
    install(ctx) {
      registerBackgroundCommandSystems(ctx.scheduler);
    }
  };
}
