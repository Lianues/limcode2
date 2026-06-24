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
    description: `切换当前工作环境。工作环境决定 read、edit、write、shell/bash 等工具解析相对路径和默认 cwd 时使用的根目录。

传入目标工作环境 id 即可。切换后后续工具参数保持不变，仍使用相对路径 / 相对 cwd。`,
    parameters: {
      type: 'object',
      properties: {
        workEnvironmentId: {
          type: 'string',
          description: '目标工作环境 id。使用工具定义中列出的工作环境 id。'
        }
      },
      required: ['workEnvironmentId']
    },
    metadata: {
      category: 'general',
      scope: 'workEnvironment',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
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
