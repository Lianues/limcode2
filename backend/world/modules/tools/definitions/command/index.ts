import type { CommandCapability, CommandOutputLimits } from '../../../../../capabilities/types';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
import { BackgroundCommandEventType } from '../../../backgroundCommand/events';
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
            description: 'Required. Briefly explain to the user what this command will do and why. This text is shown as the tool-call title.'
          },
          mode: {
            type: 'string',
            description: 'Operation mode. Defaults to execute. execute starts a new command; output reads accumulated output from a background process; kill terminates a background process. output/kill require a processId returned by an earlier execute result.'
          },
          command: {
            type: 'string',
            description: command.toolName === 'shell'
              ? 'PowerShell command to execute. Separate multiple commands with semicolons. Quote paths that contain spaces. Required when mode=execute.'
              : 'Bash/Shell command to execute. Prefer joining multiple commands with &&. Quote paths that contain spaces. Required when mode=execute.'
          },
          cwd: {
            type: 'string',
            description: 'Working directory relative to the workspace root. Defaults to the workspace root. Only used when mode=execute.'
          },
          foregroundWaitMs: {
            type: 'number',
            description: 'Required for mode=execute. Foreground wait budget in milliseconds; this is not a command timeout. If the command is still running after this budget, it is moved to the background and the tool returns a generated processId. Use 0 to background immediately.'
          },
          processId: {
            type: 'string',
            description: 'Do not provide this when mode=execute. The runtime generates and returns processId when an execute command is moved to the background. Required only for mode=output or mode=kill; copy it from a previous shell/bash result or background notification.'
          },
          readonly: {
            type: 'string',
            description: 'Whether this command is read-only and does not modify files, system state, or network state. Use "true" for read-only commands; read-only commands may be auto-approved when the policy allows it.'
          },
          wait: {
            type: 'string',
            description: 'Whether to wait for previous tool calls before starting this one. Defaults to serial execution. Set to "false" to allow parallel execution.'
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
        },
        onBackgroundExit(event) {
          if (!ctx?.emitWorldEvent) return;
          const output = event.result;
          const processId = output.processId?.trim();
          if (!processId) return;
          ctx.emitWorldEvent({
            type: BackgroundCommandEventType.Exited,
            payload: {
              processId,
              toolName: command.toolName,
              toolCallId: ctx.toolCallId,
              ...(ctx.runId ? { runId: ctx.runId } : {}),
              ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
              command: output.command,
              cwd: resolvedCommandCwd(args.cwd, ctx.workEnvironment?.rootPath),
              status: output.status === 'killed' ? 'killed' : 'exited',
              exitCode: output.exitCode,
              killed: output.killed,
              stdout: output.stdout,
              stderr: output.stderr,
              ...(output.droppedChars !== undefined ? { droppedChars: output.droppedChars } : {})
            }
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

function resolvedCommandCwd(cwd: string | undefined, rootPath: string | undefined): string {
  const explicit = cwd?.trim();
  if (explicit) return explicit;
  return rootPath?.trim() ?? '';
}

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
