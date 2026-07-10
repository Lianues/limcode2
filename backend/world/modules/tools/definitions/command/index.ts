import type { CommandCapability, CommandOutputLimits } from '../../../../../capabilities/types';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { defineToolDefinitionModule } from '../types';

export const commandToolModule = defineToolDefinitionModule({
  id: 'command',
  create({ command }) {
    return createCommandTool(command);
  }
});

const DEFAULT_MAX_OUTPUT_LINES = 100;
const DEFAULT_MAX_OUTPUT_CHARS = 10_000;

export function createCommandTool(command: CommandCapability): ToolDefinition {
  return {
    declaration: {
      name: command.toolName,
      description: command.description,
      parameters: {
        type: 'object',
        properties: {
          explanation: {
            type: 'string',
            description: '必填。用一句简体中文向用户概括本次要执行什么、为什么这样做（面向用户，而非罗列技术细节）。该说明会作为工具消息标题展示给用户。'
          },
          mode: {
            type: 'string',
            description: '操作模式，默认 execute。execute=执行新命令；output=获取某后台进程自上次读取以来的新增输出(需 processId)；kill=终止某后台进程(需 processId)。'
          },
          command: {
            type: 'string',
            description: command.toolName === 'shell'
              ? '要执行的 PowerShell 命令。多条命令用分号分隔。路径含空格时用双引号包裹。（mode=execute 时必填）'
              : '要执行的 Bash/Shell 命令。多条命令建议用 && 连接。路径含空格时用双引号包裹。（mode=execute 时必填）'
          },
          cwd: {
            type: 'string',
            description: '工作目录（相对于工作区根目录），默认为工作区根目录。仅 mode=execute 有效。'
          },
          foregroundWaitMs: {
            type: 'number',
            description: '必填。前台等待预算（毫秒），不是命令超时/终止时间。mode=execute 时，命令启动后工具最多在当前响应中等待这么久：期间完成则同步返回结果；到点仍在运行则不杀进程，转入后台继续运行并返回 processId。设为 0 表示启动后立即转后台（适合长期服务、构建、打包等长任务）。'
          },
          processId: {
            type: 'string',
            description: 'mode=output / mode=kill 时必填。目标后台进程的 id（由 execute 因前台等待预算用尽或 foregroundWaitMs=0 转后台时返回）。'
          },
          readonly: {
            type: 'string',
            description: '本次命令是否只读（不修改文件/系统/网络状态），"true" 表示只读。由你根据命令自行判断。只读命令在开启"只读命令自动跳过审批"时可免审批直接执行；其他命令仍按常规审批。'
          },
          wait: {
            type: 'string',
            description: '是否等待前面的工具执行完再执行。默认串行(等待)。传 "false" 表示不等待、与前面的工具并行执行。'
          }
        },
        required: ['explanation', 'foregroundWaitMs']
      },
      metadata: {
        category: 'command',
        scope: 'command',
        riskLevel: 'command',
        readonly: false,
        defaultEnabled: true,
        requiresApproval: true,
        checkpoint: { before: true, after: true }
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
          },
          {
            key: 'autoApproveReadonly',
            label: '只读命令自动跳过审批',
            type: 'boolean',
            description: '开启后，即使未开启"自动批准执行"，被模型标记为只读(readonly=true)的命令也会自动批准、无需人工确认。',
            defaultValue: true
          },
          {
            key: 'maxOutputLines',
            label: '输出最大行数',
            type: 'number',
            description: '返回给模型的 stdout/stderr 最多保留的行数（保留末尾若干行）。默认 100。',
            defaultValue: DEFAULT_MAX_OUTPUT_LINES
          },
          {
            key: 'maxOutputChars',
            label: '输出最大字符数',
            type: 'number',
            description: '返回给模型的 stdout/stderr 最多保留的字符数（保留末尾字符）。默认 10000。',
            defaultValue: DEFAULT_MAX_OUTPUT_CHARS
          }
        ]
      },
      defaultConfig: {
        denyCommands: [],
        allowCommands: [],
        autoApproveReadonly: true,
        maxOutputLines: DEFAULT_MAX_OUTPUT_LINES,
        maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS
      }
    },
    execution: 'runtime',
    scheduling: (rawArgs) => resolveCommandScheduling(rawArgs),
    summary: summarizeCommandToolCall,
    async execute(rawArgs, deps, ctx) {
      const args = (rawArgs ?? {}) as CommandToolArgs;
      const config = normalizeCommandToolConfig(ctx?.config);
      const limits: CommandOutputLimits = { maxOutputLines: config.maxOutputLines, maxOutputChars: config.maxOutputChars };
      const mode = args.mode === 'output' || args.mode === 'kill' ? args.mode : 'execute';

      if (mode === 'output') {
        const processId = (args.processId ?? '').trim();
        if (!processId) return { ok: false, output: '缺少 processId：mode=output 需要指定后台进程 id。' };
        return { ok: true, output: deps.command.readOutput(processId, limits) };
      }

      if (mode === 'kill') {
        const processId = (args.processId ?? '').trim();
        if (!processId) return { ok: false, output: '缺少 processId：mode=kill 需要指定后台进程 id。' };
        return { ok: true, output: deps.command.kill(processId) };
      }

      const commandText = (args.command ?? '').trim();
      if (!commandText) return { ok: false, output: 'mode=execute 需要提供 command。' };
      if (typeof args.foregroundWaitMs !== 'number' || !Number.isFinite(args.foregroundWaitMs) || args.foregroundWaitMs < 0) {
        return { ok: false, output: 'foregroundWaitMs 为必填参数，需为非负的毫秒数（0 表示启动后立即转后台）。' };
      }
      const deniedBy = firstMatchedCommandRule(commandText, config.denyCommands);
      if (deniedBy) return { ok: false, output: `命令已被工具策略黑名单拒绝：${deniedBy}` };

      const result = await deps.command.run({ command: args.command, cwd: args.cwd, foregroundWaitMs: args.foregroundWaitMs, executionId: ctx?.toolCallId }, {
        onEvent(event) {
          ctx?.emit({
            kind: event.kind,
            ...(event.delta !== undefined ? { delta: event.delta } : {}),
            ...(event.payload !== undefined ? { payload: event.payload } : {})
          });
        }
      }, { workEnvironment: ctx?.workEnvironment, accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments }, limits);
      // 转入后台(running)不算失败；否则以退出码判定。
      const ok = result.status === 'running' || result.exitCode === 0;
      return { ok, output: result };
    }
  };
}

type CommandToolArgs = {
  command?: string;
  cwd?: string;
  foregroundWaitMs?: number;
  mode?: string;
  processId?: string;
  readonly?: string;
  wait?: string;
  explanation?: string;
};

function summarizeCommandToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as CommandToolArgs;
  const explanation = typeof args.explanation === 'string' ? args.explanation.trim() : '';
  if (!explanation) return undefined;
  return explanation.replace(/\s+/g, ' ');
}

/** 串并行调度：默认串行；仅当 wait 显式为 "false" 时并行(不等待前面的工具)。 */
function resolveCommandScheduling(rawArgs: unknown): { mode: 'parallel' | 'serial'; reason: string } {
  const args = (rawArgs ?? {}) as CommandToolArgs;
  const wait = typeof args.wait === 'string' ? args.wait.trim().toLowerCase() : '';
  if (wait === 'false') return { mode: 'parallel', reason: 'explicit_parallel' };
  return { mode: 'serial', reason: 'default_serial' };
}

/** 判断某次命令工具调用是否被模型标记为只读（供审批放行使用）。 */
export function isReadonlyCommandCall(rawArgs: unknown): boolean {
  const args = (rawArgs ?? {}) as CommandToolArgs;
  return typeof args.readonly === 'string' && args.readonly.trim().toLowerCase() === 'true';
}

interface NormalizedCommandToolConfig {
  denyCommands: string[];
  allowCommands: string[];
  autoApproveReadonly: boolean;
  maxOutputLines: number;
  maxOutputChars: number;
}

function normalizeCommandToolConfig(config: ToolConfigRecord | undefined): NormalizedCommandToolConfig {
  return {
    denyCommands: normalizeStringList(config?.denyCommands),
    allowCommands: normalizeStringList(config?.allowCommands),
    autoApproveReadonly: config?.autoApproveReadonly !== false,
    maxOutputLines: normalizePositiveInt(config?.maxOutputLines, DEFAULT_MAX_OUTPUT_LINES),
    maxOutputChars: normalizePositiveInt(config?.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS)
  };
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
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
