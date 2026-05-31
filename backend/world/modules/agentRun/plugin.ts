import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { agentRunClientSyncContributor } from './clientSync';
import { registerAgentRunSystems } from './systems';

export function agentRunPlugin(): WorldPlugin {
  return {
    name: 'agentRun',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(agentRunClientSyncContributor);
      registerAgentRunSystems(ctx.scheduler);
    }
  };
}
