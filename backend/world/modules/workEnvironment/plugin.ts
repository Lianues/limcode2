import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { workEnvironmentClientSyncContributor } from './clientSync';
import { workEnvironmentStorageStateContributor } from './storageProjection';
import { registerWorkEnvironmentSystems } from './systems';

export function workEnvironmentPlugin(): WorldPlugin {
  return {
    name: 'workEnvironment',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(workEnvironmentClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(workEnvironmentStorageStateContributor);
      registerWorkEnvironmentSystems(ctx.scheduler);
    }
  };
}
