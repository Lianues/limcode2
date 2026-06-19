import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { checkpointClientSyncContributor } from './clientSync';
import { checkpointStorageStateContributor } from './storageProjection';
import { registerCheckpointSystems } from './systems';

export function checkpointPlugin(): WorldPlugin {
  return {
    name: 'checkpoint',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(checkpointClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(checkpointStorageStateContributor);
      registerCheckpointSystems(ctx.scheduler);
    }
  };
}
