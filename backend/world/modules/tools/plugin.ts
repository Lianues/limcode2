import type { WorldPlugin } from '../../plugin';
import type { ToolDefinitionRecord } from '../../../../shared/protocol';
import type { ToolSchema } from '../llm/contracts';
import type { ToolDefinition } from './registry';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { toolsClientSyncContributor } from './clientSync';
import { toolsStorageStateContributor } from './storageProjection';
import { McpToolSourcesKey, ToolDefinitionsKey, ToolRuntimeDefinitionsKey, ToolSchemasKey } from './resources';
import { registerToolSystems } from './systems';

export interface ToolsPluginOptions {
  toolSchemas: ToolSchema[];
  toolDefinitions: ToolDefinitionRecord[];
  toolRuntimeDefinitions: ToolDefinition[];
}

export function toolsPlugin(options: ToolsPluginOptions): WorldPlugin {
  return {
    name: 'tools',
    install(ctx) {
      ctx.world.setResource(ToolSchemasKey, options.toolSchemas);
      ctx.world.setResource(ToolDefinitionsKey, options.toolDefinitions);
      ctx.world.setResource(ToolRuntimeDefinitionsKey, options.toolRuntimeDefinitions);
      ctx.world.setResource(McpToolSourcesKey, []);
      ctx.world.getResource(ClientStateContributorsKey).register(toolsClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(toolsStorageStateContributor);
      registerToolSystems(ctx.scheduler);
    }
  };
}
