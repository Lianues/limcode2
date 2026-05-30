import type { WorldPlugin } from '../plugin';
import { ClientStateContributorRegistry } from './contributors';
import { ClientStateContributorsKey, ClientSyncStateKey } from './resources';
import { registerClientSyncSystems } from './systems';

export function clientSyncPlugin(): WorldPlugin {
  return {
    name: 'clientSync',
    install(ctx) {
      ctx.world.setResource(ClientStateContributorsKey, new ClientStateContributorRegistry());
      ctx.world.setResource(ClientSyncStateKey, { lastState: null, streams: {} });
      registerClientSyncSystems(ctx.scheduler);
    }
  };
}
