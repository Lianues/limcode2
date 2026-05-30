import { ToolRegistry } from './registry';
import type { CommandCapability } from '../../../capabilities/types';
import { createBuiltinToolDefinitions } from './definitions';

export * from './components';
export * from './bundles';
export * from './effects';
export * from './events';
export * from './registry';
export * from './resources';
export * from './state';
export * from './definitions';
export * from './plugin';

export function createToolRegistry(command: CommandCapability): ToolRegistry {
  return new ToolRegistry().registerMany(createBuiltinToolDefinitions({ command }));
}
