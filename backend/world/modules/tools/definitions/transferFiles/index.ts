import { TRANSFER_FILES_TOOL_NAME } from '../../../../../../shared/protocol';
import type { WorkEnvironmentTransferArgs } from '../../../../../capabilities/types';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

export const transferFilesToolModule = defineToolDefinitionModule({
  id: TRANSFER_FILES_TOOL_NAME,
  create() {
    return transferFilesTool;
  }
});

export const transferFilesTool: ToolDefinition = {
  declaration: {
    name: TRANSFER_FILES_TOOL_NAME,
    description: [
      '在不同工作环境之间传输文件或目录。支持本地工作区 ↔ 远程服务器、远程服务器 ↔ 远程服务器、本地 ↔ 本地。',
      'fromEnvironment / toEnvironment 使用工作环境 id；也可以使用 current 表示当前 active 工作环境。',
      '路径必须使用绝对路径：本地如 C:\\path\\file 或 /home/me/file，远端如 /root/file。',
      '路径以 / 或 \\ 结尾表示目录；type=auto 时会根据源路径 stat 结果自动判断。',
      '默认 overwrite=false，目标存在会失败；文件写入采用临时文件 + 校验 + rename。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        transfers: {
          type: 'array',
          description: '传输任务数组。必须是数组，即使只传一个文件也要用数组。',
          items: {
            type: 'object',
            properties: {
              fromEnvironment: { type: 'string', description: '源工作环境 id，或 current 表示当前 active 工作环境。' },
              fromPath: { type: 'string', description: '源绝对路径。目录建议以 / 或 \\ 结尾。' },
              toEnvironment: { type: 'string', description: '目标工作环境 id，或 current 表示当前 active 工作环境。' },
              toPath: { type: 'string', description: '目标绝对路径。传目录时表示目标目录本身。' },
              type: { type: 'string', enum: ['auto', 'file', 'directory'], description: '传输类型，默认 auto。' },
              overwrite: { type: 'boolean', description: '目标存在时是否覆盖，默认 false。' },
              createDirs: { type: 'boolean', description: '是否自动创建目标父目录/目标目录，默认 true。' }
            },
            required: ['fromEnvironment', 'fromPath', 'toEnvironment', 'toPath']
          }
        },
        verify: { type: 'string', enum: ['none', 'size'], description: '校验模式。none=不校验；size=比较源/目标文件大小（默认）。' }
      },
      required: ['transfers']
    },
    metadata: {
      category: 'filesystem',
      scope: 'file',
      riskLevel: 'write',
      readonly: false,
      defaultEnabled: true,
      requiresApproval: true,
      checkpoint: { before: true, after: true }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'file_transfer_side_effect'),
  summary: summarizeTransferFilesToolCall,
  async execute(rawArgs, deps, ctx) {
    const args = (rawArgs ?? {}) as WorkEnvironmentTransferArgs;
    const result = await deps.workEnvironment.transferFiles(args, {
      onEvent(event) {
        ctx?.emit({
          kind: event.kind,
          ...(event.delta !== undefined ? { delta: event.delta } : {}),
          ...(event.payload !== undefined ? { payload: event.payload, progress: event.payload } : {})
        });
      }
    }, {
      activeWorkEnvironment: ctx?.workEnvironment,
      availableWorkEnvironments: ctx?.workEnvironments
    });
    return { ok: result.failCount === 0, output: result };
  }
};

function summarizeTransferFilesToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as WorkEnvironmentTransferArgs;
  const transfers = Array.isArray(args.transfers) ? args.transfers : [];
  const first = transfers[0];
  if (!first) return '传输文件';
  const from = [first.fromEnvironment, first.fromPath].filter(Boolean).join(':');
  const to = [first.toEnvironment, first.toPath].filter(Boolean).join(':');
  const suffix = transfers.length > 1 ? ` +${transfers.length - 1}` : '';
  return `${from} → ${to}${suffix}`;
}
