import {
  TASK_LIST_ITEM_STATUSES,
  TASK_LIST_TOOL_NAME,
  type TaskListItemStatus,
  type TaskListToolItemRecord,
  type TaskListToolMode,
  type TaskListToolOperationRecord,
  type TaskListToolOutputRecord
} from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

interface TaskListToolArgs {
  mode?: unknown;
  items?: unknown;
}

const ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: '任务标题。update 模式下优先按 title 匹配已有任务；建议使用简短动宾短语。'
    },
    description: {
      type: 'string',
      description: '任务的补充说明、验收条件或上下文。'
    },
    activeForm: {
      type: 'string',
      description: '任务进行中时显示的现在进行时文案，例如「运行类型检查」。'
    },
    status: {
      type: 'string',
      enum: TASK_LIST_ITEM_STATUSES,
      description: '任务状态：pending 待处理；in_progress 进行中；completed 已完成；blocked 受阻；cancelled 已取消。'
    },
    delete: {
      type: 'boolean',
      description: '仅 update 模式使用。设为 true 时删除同 title 的任务。'
    }
  },
  required: ['title']
};

export const taskListToolModule = defineToolDefinitionModule({
  id: TASK_LIST_TOOL_NAME,
  create() {
    return taskListTool;
  }
});

export const taskListTool: ToolDefinition = {
  declaration: {
    name: TASK_LIST_TOOL_NAME,
    description: `更新当前对话的结构化任务清单。这个工具只记录结构化任务清单操作，不会修改工作区文件。

使用模式：
- mode="rewrite"：本次 items 是当前任务/计划应显示的完整任务清单，会替换前序任务清单。
- mode="update"：本次 items 只是增量变更；按 title 匹配已有任务并更新，不存在则新增；delete=true 删除同 title 任务。

使用规则：
- 复杂、多步骤、跨文件或用户明确要求跟踪进度时，先用 rewrite 创建 3-8 个任务。
- 开始某项工作前，把该项设为 in_progress；完成后立即设为 completed。
- 同一时间只保留一个 in_progress；前端会把旧的 in_progress 自动退回 pending。
- 遇到新的、明显不是同一批工作的用户任务/新计划/新阶段时，使用 rewrite，避免不同任务混在一个清单里。
- 继续同一批工作时使用 update，只提交发生变化的条目即可。
- 这不是最终回复文本；前端会根据当前对话中的工具调用动态显示任务清单。`,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['rewrite', 'update'],
          description: 'rewrite=重写完整任务清单；update=增量更新任务清单。'
        },
        items: {
          type: 'array',
          items: ITEM_SCHEMA,
          description: '任务条目。rewrite 表示完整清单；update 表示变更条目。'
        }
      },
      required: ['mode', 'items']
    },
    metadata: {
      category: 'general',
      scope: 'task',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'task_list_state_update'),
  summary: summarizeTaskListToolCall,
  async execute(rawArgs) {
    const operation = normalizeTaskListOperation(rawArgs);
    const output: TaskListToolOutputRecord = {
      kind: 'task_list.result',
      operation,
      summary: formatOperationSummary(operation)
    };
    return { ok: true, output };
  }
};

function summarizeTaskListToolCall(rawArgs: unknown): string | undefined {
  try {
    const operation = normalizeTaskListOperation(rawArgs);
    const modeLabel = operation.mode === 'rewrite' ? '重写任务清单' : '更新任务清单';
    const count = operation.items.length;
    const active = operation.items.find((item) => item.status === 'in_progress' && item.delete !== true);
    return `${modeLabel} · ${count} 项${active ? ` · 当前：${active.title}` : ''}`;
  } catch {
    return undefined;
  }
}

function normalizeTaskListOperation(rawArgs: unknown): TaskListToolOperationRecord {
  const args = asRecord(rawArgs) as TaskListToolArgs | undefined;
  if (!args) throw new Error('update_task_list 参数必须是对象');

  const mode = normalizeMode(args.mode);
  const items = normalizeItems(args.items, mode);
  return {
    kind: 'task_list.operation',
    mode,
    items
  };
}

function normalizeMode(value: unknown): TaskListToolMode {
  if (value === 'rewrite' || value === 'update') return value;
  throw new Error('mode 必须是 rewrite 或 update');
}

function normalizeItems(value: unknown, mode: TaskListToolMode): TaskListToolItemRecord[] {
  if (!Array.isArray(value)) throw new Error('items 必须是数组');
  return value.map((item, index) => normalizeItem(item, index, mode));
}

function normalizeItem(value: unknown, index: number, mode: TaskListToolMode): TaskListToolItemRecord {
  const record = asRecord(value);
  if (!record) throw new Error(`items[${index}] 必须是对象`);

  const title = asRequiredString(record.title, `items[${index}].title`);
  const deletion = record.delete === true;
  if (mode === 'rewrite' && deletion) {
    throw new Error(`items[${index}].delete 只能在 update 模式使用`);
  }

  const description = asOptionalString(record.description);
  const activeForm = asOptionalString(record.activeForm);
  const status = deletion ? undefined : normalizeOptionalStatus(record.status, index);

  return {
    title,
    ...(description ? { description } : {}),
    ...(activeForm ? { activeForm } : {}),
    ...(status ? { status } : {}),
    ...(deletion ? { delete: true } : {})
  };
}

function normalizeOptionalStatus(value: unknown, index: number): TaskListItemStatus | undefined {
  if (value === undefined) return undefined;
  if (isTaskStatus(value)) return value;
  throw new Error(`items[${index}].status 必须是 ${TASK_LIST_ITEM_STATUSES.join(' / ')} 之一`);
}

function isTaskStatus(value: unknown): value is TaskListItemStatus {
  return typeof value === 'string' && (TASK_LIST_ITEM_STATUSES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是非空字符串`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) throw new Error(`${label} 必须是非空字符串`);
  return text;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text : undefined;
}

function formatOperationSummary(operation: TaskListToolOperationRecord): string {
  const modeLabel = operation.mode === 'rewrite' ? '已重写任务清单' : '已更新任务清单';
  const active = operation.items.find((item) => item.status === 'in_progress' && item.delete !== true);
  const deleted = operation.items.filter((item) => item.delete === true).length;
  const changed = operation.items.length - deleted;
  const detail = [
    changed > 0 ? `${changed} 项变更` : undefined,
    deleted > 0 ? `${deleted} 项删除` : undefined,
    active ? `当前：${active.title}` : undefined
  ].filter(Boolean).join('；');
  return detail ? `${modeLabel}：${detail}` : `${modeLabel}。`;
}
