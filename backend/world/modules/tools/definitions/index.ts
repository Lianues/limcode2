import type { ToolDefinition } from '../registry';
import { commandToolModule } from './command';
import { readFileToolModule } from './readFile';
import { runAgentToolModule } from './runAgent';
import { switchWorkEnvironmentToolModule } from './switchWorkEnvironment';
import { taskListToolModule } from './taskList';
import type { ToolDefinitionContext, ToolDefinitionModule } from './types';

export * from './types';
export { commandToolModule, createCommandTool } from './command';
export { readFileToolModule, readFileTool } from './readFile';
export { runAgentToolModule, runAgentTool } from './runAgent';
export { switchWorkEnvironmentToolModule, switchWorkEnvironmentTool } from './switchWorkEnvironment';
export { taskListToolModule, taskListTool } from './taskList';

const BUILTIN_TOOL_MODULES: readonly ToolDefinitionModule[] = [
  taskListToolModule,
  switchWorkEnvironmentToolModule,
  readFileToolModule,
  runAgentToolModule,
  commandToolModule
];

export function createBuiltinToolDefinitions(context: ToolDefinitionContext): ToolDefinition[] {
  return BUILTIN_TOOL_MODULES.map((module) => module.create(context));
}
