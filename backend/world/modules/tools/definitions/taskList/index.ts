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

export const TASK_LIST_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description: 'Task title. In update mode this is also used as the key to match existing tasks; prefer a short verb-object phrase.'
    },
    description: {
      type: 'string',
      description: 'Additional notes, acceptance criteria, or context for the task. Also shown as the current-activity line while the task is in progress.'
    },
    status: {
      type: 'string',
      description: 'Task status: pending, in_progress, completed, blocked, or cancelled.'
    },
    delete: {
      type: 'boolean',
      description: 'Only used in update mode. Set to true to delete the task with the same title.'
    }
  },
  required: ['title']
};

export const TASK_LIST_OPERATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: ['rewrite', 'update'],
      description: 'rewrite = replace the full task list; update = apply incremental changes to the task list.'
    },
    items: {
      type: 'array',
      items: TASK_LIST_ITEM_SCHEMA,
      description: 'Task entries. In rewrite mode this is the full list; in update mode these are the changed entries.'
    }
  },
  required: ['mode', 'items']
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
    description: `Update the structured task list for the current conversation. This tool only records structured task list operations; it does not modify workspace files.

Modes:
- mode="rewrite": the items are the full task list that should currently be shown for the task/plan, and they replace the previous task list.
- mode="update": the items are incremental changes; existing tasks are matched and updated by title, new titles are added, and delete=true removes the task with the same title.

Usage rules:
- For complex, multi-step, cross-file work, or when the user explicitly asks to track progress, first use rewrite to create 3-8 tasks.
- Before starting a piece of work, set it to in_progress; mark it completed as soon as it is done.
- Keep only one in_progress task at a time; the frontend automatically moves the previous in_progress task back to pending.
- When a new, clearly separate user task / new plan / new phase comes up, use rewrite so unrelated tasks are not mixed into one list.
- When continuing the same batch of work, use update and only submit the entries that changed.
- This is not the final reply text; the frontend renders the task list dynamically from the tool calls in the current conversation.`,
    parameters: TASK_LIST_OPERATION_SCHEMA,
    metadata: {
      category: 'general',
      scope: 'task',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
      defaultAutoExpand: true,
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
  if (!args) throw new Error('update_task_list arguments must be an object');

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
  throw new Error('mode must be rewrite or update');
}

function normalizeItems(value: unknown, mode: TaskListToolMode): TaskListToolItemRecord[] {
  if (!Array.isArray(value)) throw new Error('items must be an array');
  return value.map((item, index) => normalizeItem(item, index, mode));
}

function normalizeItem(value: unknown, index: number, mode: TaskListToolMode): TaskListToolItemRecord {
  const record = asRecord(value);
  if (!record) throw new Error(`items[${index}] must be an object`);

  const title = asRequiredString(record.title, `items[${index}].title`);
  const deletion = record.delete === true;
  if (mode === 'rewrite' && deletion) {
    throw new Error(`items[${index}].delete can only be used in update mode`);
  }

  const description = asOptionalString(record.description);
  const status = deletion ? undefined : normalizeOptionalStatus(record.status);

  return {
    title,
    ...(description ? { description } : {}),
    ...(status ? { status } : {}),
    ...(deletion ? { delete: true } : {})
  };
}

function normalizeOptionalStatus(value: unknown): TaskListItemStatus | undefined {
  return isTaskStatus(value) ? value : undefined;
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
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) throw new Error(`${label} must be a non-empty string`);
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
