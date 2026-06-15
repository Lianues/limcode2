import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { modeClientSyncContributor } from './clientSync';
import { modeStorageStateContributor } from './storageProjection';
import { registerModeSystems } from './systems';

export function modePlugin(): WorldPlugin {
  return {
    name: 'mode',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(modeClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(modeStorageStateContributor);
      registerModeSystems(ctx.scheduler);
    }
  };
}
