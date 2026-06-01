import type { WorldPlugin } from '../../plugin';
import type { ToolSchema } from '../llm/contracts';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { toolsClientSyncContributor } from './clientSync';
import { toolsStorageStateContributor } from './storageProjection';
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
      ctx.world.getResource(StorageStateContributorsKey).register(toolsStorageStateContributor);
      registerToolSystems(ctx.scheduler);
    }
  };
}
