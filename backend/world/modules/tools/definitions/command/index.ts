import type { CommandCapability } from '../../../../../capabilities/types';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { normalizeSchedulingHint } from '../../scheduling';
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
          },
          scheduling: {
            type: 'string',
            enum: ['auto', 'parallel', 'serial'],
            description: '工具调度提示。auto=后端按命令只读性自动判断；parallel=明确进入并行批次；serial=按原始顺序串行执行。默认 auto。'
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
    scheduling: (rawArgs) => resolveCommandScheduling(command.toolName, rawArgs),
    summary: summarizeCommandToolCall,
    async execute(rawArgs, deps, ctx) {
      const args = (rawArgs ?? {}) as CommandToolArgs;
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
      return { ok: result.exitCode === 0, output: result };
    }
  };
}

type CommandToolArgs = Parameters<CommandCapability['run']>[0] & {
  scheduling?: string;
};

function summarizeCommandToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as CommandToolArgs;
  const commandText = typeof args.command === 'string' ? args.command.trim() : '';
  if (!commandText) return undefined;
  return commandText.replace(/\s+/g, ' ');
}

function resolveCommandScheduling(toolName: 'shell' | 'bash', rawArgs: unknown): { mode: 'parallel' | 'serial'; reason: string } {
  const args = (rawArgs ?? {}) as CommandToolArgs;
  const commandText = (args.command ?? '').trim();
  const hint = normalizeSchedulingHint(args.scheduling);
  const readonlyCommand = isReadonlyCommandText(toolName, commandText);

  if (hint === 'serial') return { mode: 'serial', reason: 'explicit_serial' };
  if (hint === 'parallel') return { mode: 'parallel', reason: 'explicit_parallel' };
  return readonlyCommand
    ? { mode: 'parallel', reason: 'auto_readonly_command' }
    : { mode: 'serial', reason: 'auto_command_side_effect_barrier' };
}
function isReadonlyCommandText(toolName: 'shell' | 'bash', command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (/(?:^|[^\-])(?:>>?|2>>?)\s*[^&]/.test(trimmed)) return false;
  const statements = trimmed.split(/\s*(?:;|&&|\|\||\r?\n)\s*/).map((item) => item.trim()).filter(Boolean);
  return statements.length > 0 && statements.every((statement) => statement.split(/\s*\|\s*/).every((part) => isReadonlyCommandPart(toolName, part)));
}

function isReadonlyCommandPart(toolName: 'shell' | 'bash', statement: string): boolean {
  const tokens = statement.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase().replace(/\.exe$/, '');
  if (!first) return false;
  const rest = tokens.slice(1).map((token) => token.toLowerCase());
  if (first === 'git') return isReadonlyGitCommand(rest[0]);
  if (toolName === 'shell') return POWERSHELL_READONLY_COMMANDS.has(first);
  return BASH_READONLY_COMMANDS.has(first);
}

function isReadonlyGitCommand(subcommand: string | undefined): boolean {
  return !!subcommand && GIT_READONLY_SUBCOMMANDS.has(subcommand);
}

const GIT_READONLY_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'grep', 'describe', 'remote']);
const BASH_READONLY_COMMANDS = new Set(['pwd', 'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'sed', 'awk', 'wc', 'stat', 'du', 'df', 'tree', 'echo', 'date', 'which', 'whereis', 'file', 'sort', 'uniq']);
const POWERSHELL_READONLY_COMMANDS = new Set(['pwd', 'cd', 'dir', 'ls', 'gci', 'get-childitem', 'cat', 'type', 'gc', 'get-content', 'select-string', 'sls', 'findstr', 'rg', 'where.exe', 'where', 'get-location', 'gl', 'get-item', 'gi', 'get-command', 'measure-object', 'sort-object', 'select-object', 'echo', 'write-output', 'date', 'get-date']);


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
