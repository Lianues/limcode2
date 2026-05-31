import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { modeClientSyncContributor } from './clientSync';

export function modePlugin(): WorldPlugin {
  return {
    name: 'mode',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(modeClientSyncContributor);
    }
  };
}
