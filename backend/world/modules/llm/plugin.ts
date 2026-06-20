import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { llmClientSyncContributor } from './clientSync';
import { llmStorageStateContributor } from './storageProjection';

export function llmPlugin(): WorldPlugin {
  return {
    name: 'llm',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(llmClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(llmStorageStateContributor);
    }
  };
}
