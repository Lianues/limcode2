import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { chatClientSyncContributor } from './clientSync';
import { chatStorageStateContributor } from './storageProjection';
import { registerChatSystems } from './systems';

export function chatPlugin(): WorldPlugin {
  return {
    name: 'chat',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(chatClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(chatStorageStateContributor);
      registerChatSystems(ctx.scheduler);
    }
  };
}
