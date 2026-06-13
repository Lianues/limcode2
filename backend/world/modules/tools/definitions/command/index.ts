import type { CommandCapability } from '../../../../../capabilities/types';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
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
            description: '保留字段。当前工具策略阶段未知命令暂时按允许执行处理，黑名单命令仍会拒绝。'
          }
        },
        required: ['command']
      },
      metadata: {
        category: 'command',
        riskLevel: 'command',
        readonly: false,
        defaultEnabled: true,
        requiresApproval: true
      },
      configSchema: {
        fields: [
          {
            key: 'denyCommands',
            label: '命令黑名单',
            type: 'stringList',
            description: '命令文本包含任一黑名单片段时，后端会自动拒绝执行。',
            placeholder: '例如：format\nshutdown\nrm -rf /'
          },
          {
            key: 'allowCommands',
            label: '命令白名单',
            type: 'stringList',
            description: '白名单命令会自动执行；当前阶段未知命令也暂时按白名单处理。',
            placeholder: '例如：git status\nnpm run compile'
          }
        ]
      },
      defaultConfig: { denyCommands: [], allowCommands: [] }
    },
    execution: 'runtime',
    async execute(rawArgs, deps, ctx) {
      const args = (rawArgs ?? {}) as Parameters<CommandCapability['run']>[0];
      const commandText = (args.command ?? '').trim();
      const deniedBy = firstMatchedCommandRule(commandText, normalizeCommandToolConfig(ctx?.config).denyCommands);
      if (deniedBy) return { ok: false, output: `命令已被工具策略黑名单拒绝：${deniedBy}` };

      const result = await deps.command.run({ ...args, force: true }, {
        onEvent(event) {
          ctx?.emit({
            kind: event.kind,
            ...(event.delta !== undefined ? { delta: event.delta } : {}),
            ...(event.payload !== undefined ? { payload: event.payload } : {})
          });
        }
      });
      return {
        ok: result.exitCode === 0,
        output: JSON.stringify(result, null, 2)
      };
    }
  };
}

function normalizeCommandToolConfig(config: ToolConfigRecord | undefined): { denyCommands: string[]; allowCommands: string[] } {
  return {
    denyCommands: normalizeStringList(config?.denyCommands),
    allowCommands: normalizeStringList(config?.allowCommands)
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function firstMatchedCommandRule(command: string, rules: readonly string[]): string | undefined {
  const normalizedCommand = command.toLowerCase();
  return rules.find((rule) => normalizedCommand.includes(rule.toLowerCase()));
}
