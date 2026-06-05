import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { projectClientSyncContributor } from './clientSync';
import { projectStorageStateContributor } from './storageProjection';

export function projectPlugin(): WorldPlugin {
  return {
    name: 'project',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(projectClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(projectStorageStateContributor);
    }
  };
}
