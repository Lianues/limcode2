import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { agentRunClientSyncContributor } from './clientSync';
import { agentRunStorageStateContributor } from './storageProjection';
import { registerAgentRunSystems } from './systems';

export function agentRunPlugin(): WorldPlugin {
  return {
    name: 'agentRun',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(agentRunClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(agentRunStorageStateContributor);
      registerAgentRunSystems(ctx.scheduler);
    }
  };
}
