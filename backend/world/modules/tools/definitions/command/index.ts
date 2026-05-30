import type { CommandCapability } from '../../../../../capabilities/types';
import type { ToolDefinition } from '../../registry';
import { defineToolDefinitionModule } from '../types';

export const commandToolModule = defineToolDefinitionModule({
  id: 'command',
  create({ command }) {
    return createCommandTool(command);
  }
});

export function createCommandTool(command: CommandCapability): ToolDefinition {
  return {
    declaration: {
      name: command.toolName,
      description: command.description,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: command.toolName === 'shell'
              ? '要执行的 PowerShell 命令。多条命令用分号分隔。路径含空格时用双引号包裹。'
              : '要执行的 Bash/Shell 命令。多条命令建议用 && 连接。路径含空格时用双引号包裹。'
          },
          cwd: {
            type: 'string',
            description: '工作目录（相对于工作区根目录），默认为工作区根目录。'
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒），默认 30000；设置为 0 表示不启用超时。'
          },
          force: {
            type: 'boolean',
            description: '强制执行未知但非黑名单命令。默认不要设置；仅在用户确认风险后使用。'
          }
        },
        required: ['command']
      }
    },
    async execute(rawArgs, deps) {
      const result = await deps.command.run((rawArgs ?? {}) as Parameters<CommandCapability['run']>[0]);
      return {
        ok: result.exitCode === 0,
        output: JSON.stringify(result, null, 2)
      };
    }
  };
}
