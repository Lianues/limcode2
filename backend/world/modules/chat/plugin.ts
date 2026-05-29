import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { chatClientSyncContributor } from './clientSync';
import { registerChatSystems } from './systems';

export function chatPlugin(): WorldPlugin {
  return {
    name: 'chat',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(chatClientSyncContributor);
      registerChatSystems(ctx.scheduler);
    }
  };
}
