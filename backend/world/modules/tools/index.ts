import { ToolRegistry } from './registry';
import { readFileTool } from './readFile';

export * from './components';
export * from './bundles';
export * from './effects';
export * from './events';
export * from './registry';
export * from './resources';
export { readFileTool };
export * from './plugin';

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry().register(readFileTool);
}
