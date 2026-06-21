import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { compressionClientSyncContributor } from './clientSync';
import { compressionStorageStateContributor } from './storageProjection';
import { registerCompressionSystems } from './systems';

export function compressionPlugin(): WorldPlugin {
  return {
    name: 'compression',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(compressionClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(compressionStorageStateContributor);
      registerCompressionSystems(ctx.scheduler);
    }
  };
}
