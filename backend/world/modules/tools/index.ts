import { ToolRegistry } from './registry';
import type { CommandCapability } from '../../../capabilities/types';
import { createCommandTool } from './commandTool';
import { readFileTool } from './readFile';

export * from './components';
export * from './bundles';
export * from './effects';
export * from './events';
export * from './registry';
export * from './resources';
export { createCommandTool };
export { readFileTool };
export * from './plugin';

export function createToolRegistry(command: CommandCapability): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(createCommandTool(command));
}
