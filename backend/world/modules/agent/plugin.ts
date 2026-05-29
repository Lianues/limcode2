import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { agentClientSyncContributor } from './clientSync';
import type { AgentBlueprintRegistry } from './blueprints';
import { AgentBlueprintsKey, createDefaultAgentBlueprints } from './blueprints';
import { registerAgentSystems } from './systems';

export interface AgentPluginOptions {
  blueprints?: AgentBlueprintRegistry;
}

export function agentPlugin(options: AgentPluginOptions = {}): WorldPlugin {
  return {
    name: 'agent',
    install(ctx) {
      ctx.world.setResource(AgentBlueprintsKey, options.blueprints ?? createDefaultAgentBlueprints());
      ctx.world.getResource(ClientStateContributorsKey).register(agentClientSyncContributor);
      registerAgentSystems(ctx.scheduler);
    }
  };
}
