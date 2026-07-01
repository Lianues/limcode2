import { SWITCH_WORK_ENVIRONMENT_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

export const switchWorkEnvironmentToolModule = defineToolDefinitionModule({
  id: SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  create() {
    return switchWorkEnvironmentTool;
  }
});

export const switchWorkEnvironmentTool: ToolDefinition = {
  declaration: {
    name: SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
    description: `Switch the current work environment. The work environment determines the root directory that tools like read, edit, write, and shell/bash use when resolving relative paths and the default cwd.

Just pass the target work environment id. After switching, subsequent tool arguments stay the same and still use relative paths / relative cwd.`,
    parameters: {
      type: 'object',
      properties: {
        workEnvironmentId: {
          type: 'string',
          description: 'Target work environment id. Use one of the work environment ids listed in the tool definition.'
        }
      },
      required: ['workEnvironmentId']
    },
    metadata: {
      category: 'general',
      scope: 'workEnvironment',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: false,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'work_environment_switch'),
  summary: summarizeSwitchWorkEnvironmentToolCall,
  async execute() {
    // 该工具由 ToolDispatchSystem 在 ECS 内处理，以便原子更新 Conversation/Run 与工作环境的 Link。
    return { ok: false, output: 'switch_work_environment 必须由 ECS ToolDispatchSystem 处理。' };
  }
};

function summarizeSwitchWorkEnvironmentToolCall(rawArgs: unknown): string | undefined {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as { workEnvironmentId?: unknown }
    : undefined;
  const target = typeof args?.workEnvironmentId === 'string' && args.workEnvironmentId.trim()
    ? args.workEnvironmentId.trim()
      : undefined;
  return target ? `切换工作环境 · ${target}` : '切换工作环境';
}
