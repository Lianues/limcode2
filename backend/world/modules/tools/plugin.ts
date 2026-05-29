import type { WorldPlugin } from '../../plugin';
import type { ToolSchema } from '../llm/contracts';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { toolsClientSyncContributor } from './clientSync';
import { ToolSchemasKey } from './resources';
import { registerToolSystems } from './systems';

export interface ToolsPluginOptions {
  toolSchemas: ToolSchema[];
}

export function toolsPlugin(options: ToolsPluginOptions): WorldPlugin {
  return {
    name: 'tools',
    install(ctx) {
      ctx.world.setResource(ToolSchemasKey, options.toolSchemas);
      ctx.world.getResource(ClientStateContributorsKey).register(toolsClientSyncContributor);
      registerToolSystems(ctx.scheduler);
    }
  };
}
