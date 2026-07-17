import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { workflowClientSyncContributor } from './clientSync';
import { workflowStorageStateContributor } from './storageProjection';
import { registerWorkflowSystems } from './systems';

export function workflowPlugin(): WorldPlugin {
  return {
    name: 'workflow',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(workflowClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(workflowStorageStateContributor);
      registerWorkflowSystems(ctx.scheduler);
    }
  };
}
