import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { agentAnswerClientSyncContributor } from './clientSync';
import { agentAnswerStorageStateContributor } from './storageProjection';

export function agentAnswerPlugin(): WorldPlugin {
  return {
    name: 'agentAnswer',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(agentAnswerClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(agentAnswerStorageStateContributor);
    }
  };
}
