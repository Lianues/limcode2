import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { runtimeContextClientSyncContributor } from './clientSync';
import { PROMPT_PLACEHOLDERS } from './placeholders';
import { PromptPlaceholdersKey } from './resources';
import { runtimeContextStorageStateContributor } from './storageProjection';
import { registerRuntimeContextSystems } from './systems';

export function runtimeContextPlugin(): WorldPlugin {
  return {
    name: 'runtimeContext',
    install(ctx) {
      ctx.world.setResource(PromptPlaceholdersKey, PROMPT_PLACEHOLDERS);
      ctx.world.getResource(ClientStateContributorsKey).register(runtimeContextClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(runtimeContextStorageStateContributor);
      registerRuntimeContextSystems(ctx.scheduler);
    }
  };
}
