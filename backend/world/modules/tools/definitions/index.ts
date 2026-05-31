import type { ToolDefinition } from '../registry';
import { commandToolModule } from './command';
import { readFileToolModule } from './readFile';
import { runAgentToolModule } from './runAgent';
import type { ToolDefinitionContext, ToolDefinitionModule } from './types';

export * from './types';
export { commandToolModule, createCommandTool } from './command';
export { readFileToolModule, readFileTool } from './readFile';
export { runAgentToolModule, runAgentTool } from './runAgent';

const BUILTIN_TOOL_MODULES: readonly ToolDefinitionModule[] = [
  readFileToolModule,
  runAgentToolModule,
  commandToolModule
];

export function createBuiltinToolDefinitions(context: ToolDefinitionContext): ToolDefinition[] {
  return BUILTIN_TOOL_MODULES.map((module) => module.create(context));
}
