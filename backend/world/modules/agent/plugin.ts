import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { agentClientSyncContributor } from './clientSync';
import { agentStorageStateContributor } from './storageProjection';
import type { BuiltinAgentRegistry } from './blueprints';
import { AgentBlueprintsKey, createDefaultAgentBlueprints } from './blueprints';
import { registerAgentSystems } from './systems';

export interface AgentPluginOptions {
  blueprints?: BuiltinAgentRegistry;
}

export function agentPlugin(options: AgentPluginOptions = {}): WorldPlugin {
  return {
    name: 'agent',
    install(ctx) {
      ctx.world.setResource(AgentBlueprintsKey, options.blueprints ?? createDefaultAgentBlueprints());
      ctx.world.getResource(ClientStateContributorsKey).register(agentClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(agentStorageStateContributor);
      registerAgentSystems(ctx.scheduler);
    }
  };
}
