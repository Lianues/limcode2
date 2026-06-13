import type { WorldPlugin } from '../../plugin';
import type { ToolDefinitionRecord } from '../../../../shared/protocol';
import type { ToolSchema } from '../llm/contracts';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { toolsClientSyncContributor } from './clientSync';
import { toolsStorageStateContributor } from './storageProjection';
import { ToolDefinitionsKey, ToolSchemasKey } from './resources';
import { registerToolSystems } from './systems';

export interface ToolsPluginOptions {
  toolSchemas: ToolSchema[];
  toolDefinitions: ToolDefinitionRecord[];
}

export function toolsPlugin(options: ToolsPluginOptions): WorldPlugin {
  return {
    name: 'tools',
    install(ctx) {
      ctx.world.setResource(ToolSchemasKey, options.toolSchemas);
      ctx.world.setResource(ToolDefinitionsKey, options.toolDefinitions);
      ctx.world.getResource(ClientStateContributorsKey).register(toolsClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(toolsStorageStateContributor);
      registerToolSystems(ctx.scheduler);
    }
  };
}
