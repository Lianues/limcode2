import type { WorldPlugin } from '../plugin';
import { ClientStateContributorRegistry } from './contributors';
import { ClientStateContributorsKey, ClientSyncFastPatchStateKey, ClientSyncStateKey } from './resources';

export function clientSyncPlugin(): WorldPlugin {
  return {
    name: 'clientSync',
    install(ctx) {
      ctx.world.setResource(ClientStateContributorsKey, new ClientStateContributorRegistry());
      ctx.world.setResource(ClientSyncStateKey, {
        lastState: null,
        projectionClock: '',
        contributorStates: {},
        streams: {}
      });
      ctx.world.setResource(ClientSyncFastPatchStateKey, {
        patches: [],
        deferFullSync: false,
        requireFullSync: false
      });
    }
  };
}
