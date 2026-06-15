import {
  isFunctionCallPart,
  TASK_LIST_ITEM_STATUSES,
  TASK_LIST_TOOL_NAME,
  type MessageRecord,
  type TaskListItemStatus,
  type TaskListToolItemRecord,
  type TaskListToolMode,
  type TaskListToolOperationRecord,
  type ToolCallRecord
} from './protocol';

const TERMINAL_STATUSES = new Set<TaskListItemStatus>(['completed', 'cancelled']);

export const TASK_LIST_STATUS_LABELS: Record<TaskListItemStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '受阻',
  cancelled: '已取消'
};

export type TaskListChangeKind = 'added' | 'updated' | 'status_changed' | 'completed' | 'deleted' | 'rewritten';

export const TASK_LIST_CHANGE_LABELS: Record<TaskListChangeKind, string> = {
  added: '新增',
  updated: '更新',
  status_changed: '状态变更',
  completed: '完成',
  deleted: '删除',
  rewritten: '重写'
};

export interface TaskListItemView {
  key: string;
  title: string;
  description?: string;
  activeForm?: string;
  status: TaskListItemStatus;
  createdOrder: number;
  updatedOrder: number;
  sourceToolCallId?: string;
}

export interface TaskListChangeItemView extends TaskListItemView {
  changeKind?: TaskListChangeKind;
  previousStatus?: TaskListItemStatus;
  deleted?: boolean;
}

export interface TaskListStatsView {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  blocked: number;
  cancelled: number;
  open: number;
}

export interface TaskListSnapshotView {
  items: TaskListItemView[];
  stats: TaskListStatsView;
  activeItem?: TaskListItemView;
}

export interface TaskListTimelineEntry {
  toolCall: ToolCallRecord;
  operation: TaskListToolOperationRecord;
  snapshotBefore: TaskListSnapshotView;
  snapshotAfter: TaskListSnapshotView;
  changes: TaskListChangeItemView[];
}

export interface TaskListTimelineView {
  entries: TaskListTimelineEntry[];
  snapshot: TaskListSnapshotView;
}



export interface TaskListOrderInput {
  operationIndex: number;
  toolCallId: string;
}

export function buildTaskListTimeline(input: {
  messages: readonly MessageRecord[];
  toolCalls: readonly ToolCallRecord[];
  conversationId: string;
}): TaskListTimelineView {
  const calls = sortedTaskListToolCalls(input.messages, input.toolCalls, input.conversationId)
    .filter(isAppliedTaskListToolCall);
  const entries: TaskListTimelineEntry[] = [];
  let snapshot = emptyTaskListSnapshot();

  calls.forEach((toolCall, operationIndex) => {
    const operation = taskListOperationFromToolCall(toolCall, { allowArgsFallback: true });
    if (!operation) return;

    const snapshotBefore = cloneSnapshot(snapshot);
    const snapshotAfter = applyTaskListOperation(snapshotBefore, operation, {
      operationIndex,
      toolCallId: toolCall.id
    });
    const changes = taskListChangesForOperation(snapshotBefore, snapshotAfter, operation);
    entries.push({ toolCall, operation, snapshotBefore, snapshotAfter, changes });
    snapshot = snapshotAfter;
  });

  return { entries, snapshot };
}

export function taskListTimelineEntryForToolCall(input: {
  messages: readonly MessageRecord[];
  toolCalls: readonly ToolCallRecord[];
  conversationId: string;
  toolCallId: string;
}): TaskListTimelineEntry | undefined {
  return buildTaskListTimeline(input).entries.find((entry) => entry.toolCall.id === input.toolCallId);
}

export function taskListOperationFromToolCall(
  toolCall: ToolCallRecord | undefined,
  options: { allowArgsFallback?: boolean } = {}
): TaskListToolOperationRecord | undefined {
  if (!toolCall || toolCall.name !== TASK_LIST_TOOL_NAME) return undefined;

  const resultOperation = taskListOperationFromToolResult(toolCall.result);
  if (resultOperation) return resultOperation;

  if (options.allowArgsFallback) return taskListOperationFromArgsJson(toolCall.args);
  return undefined;
}

export function taskListOperationFromArgs(args: unknown): TaskListToolOperationRecord | undefined {
  return normalizeOperation(args);
}

export function taskListDisplayItemsFromOperation(operation: TaskListToolOperationRecord): TaskListChangeItemView[] {
  return operation.items.map((item, index): TaskListChangeItemView => ({
    key: titleKey(item.title),
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    ...(item.activeForm ? { activeForm: item.activeForm } : {}),
    status: item.status ?? 'pending',
    createdOrder: index,
    updatedOrder: index,
    ...(item.delete ? { deleted: true, changeKind: 'deleted' as const } : {})
  }));
}

export function formatTaskListProgress(snapshot: TaskListSnapshotView): string {
  const { stats } = snapshot;
  if (stats.total === 0) return '当前没有任务。';
  const active = snapshot.activeItem;
  return `${stats.completed}/${stats.total} 已完成，${stats.open} 个未完成${active ? ` · 当前：${active.activeForm || active.title}` : ''}`;
}

export function taskListStatusLabel(status: TaskListItemStatus): string {
  return TASK_LIST_STATUS_LABELS[status];
}

export function taskListChangeLabel(change: TaskListChangeKind): string {
  return TASK_LIST_CHANGE_LABELS[change];
}

export function sortedTaskListToolCalls(
  messages: readonly MessageRecord[],
  toolCalls: readonly ToolCallRecord[],
  conversationId: string
): ToolCallRecord[] {
  const messageById = new Map(messages.map((message) => [message.id, message]));
  return toolCalls
    .filter((toolCall) => {
      if (toolCall.name !== TASK_LIST_TOOL_NAME) return false;
      const message = messageById.get(toolCall.messageId);
      return message?.conversationId === conversationId;
    })
    .sort((left, right) => compareTaskListToolCalls(left, right, messageById));
}

function compareTaskListToolCalls(
  left: ToolCallRecord,
  right: ToolCallRecord,
  messageById: ReadonlyMap<string, MessageRecord>
): number {
  const leftMessage = messageById.get(left.messageId);
  const rightMessage = messageById.get(right.messageId);
  return (leftMessage?.seq ?? 0) - (rightMessage?.seq ?? 0)
    || functionCallPartIndex(leftMessage, left) - functionCallPartIndex(rightMessage, right)
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id);
}

function functionCallPartIndex(message: MessageRecord | undefined, toolCall: ToolCallRecord): number {
  if (!message) return Number.MAX_SAFE_INTEGER;
  const functionCallId = toolCall.functionCallId ?? toolCall.id;
  const exactIndex = message.content.parts.findIndex((part) => isFunctionCallPart(part) && part.id === functionCallId);
  if (exactIndex >= 0) return exactIndex;

  const args = parseJson(toolCall.args);
  const argsText = stableJson(args);
  const matchedIndex = message.content.parts.findIndex((part) => {
    if (!isFunctionCallPart(part) || part.functionCall.name !== toolCall.name) return false;
    return stableJson(part.functionCall.args) === argsText;
  });
  return matchedIndex >= 0 ? matchedIndex : Number.MAX_SAFE_INTEGER;
}

function isAppliedTaskListToolCall(toolCall: ToolCallRecord): boolean {
  if (toolCall.status !== 'success' && toolCall.status !== 'warning') return false;
  const result = asRecord(toolCall.result);
  return result?.ok !== false;
}

function taskListOperationFromToolResult(result: unknown): TaskListToolOperationRecord | undefined {
  const resultRecord = asRecord(result);
  const output = resultRecord && 'output' in resultRecord ? resultRecord.output : result;
  const outputRecord = asRecord(output);
  if (!outputRecord) return undefined;

  if (outputRecord.kind === 'task_list.result') {
    return normalizeOperation(outputRecord.operation);
  }
  if (outputRecord.kind === 'task_list.operation') {
    return normalizeOperation(outputRecord);
  }
  return undefined;
}

function taskListOperationFromArgsJson(argsJson: string): TaskListToolOperationRecord | undefined {
  return normalizeOperation(parseJson(argsJson));
}

function normalizeOperation(value: unknown): TaskListToolOperationRecord | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const mode = normalizeMode(record.mode);
  if (!mode || !Array.isArray(record.items)) return undefined;

  const items: TaskListToolItemRecord[] = [];
  for (const rawItem of record.items) {
    const item = normalizeOperationItem(rawItem);
    if (item) items.push(item);
  }
  return { kind: 'task_list.operation', mode, items };
}

function normalizeMode(value: unknown): TaskListToolMode | undefined {
  return value === 'rewrite' || value === 'update' ? value : undefined;
}

function normalizeOperationItem(value: unknown): TaskListToolItemRecord | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const title = stringValue(record.title);
  if (!title) return undefined;
  const description = stringValue(record.description);
  const activeForm = stringValue(record.activeForm);
  const status = taskStatusValue(record.status);
  const deletion = record.delete === true;
  return {
    title,
    ...(description ? { description } : {}),
    ...(activeForm ? { activeForm } : {}),
    ...(status && !deletion ? { status } : {}),
    ...(deletion ? { delete: true } : {})
  };
}

export function applyTaskListOperationToSnapshot(
  snapshot: TaskListSnapshotView,
  operation: TaskListToolOperationRecord,
  order: TaskListOrderInput
): TaskListSnapshotView {
  const byKey = new Map<string, TaskListItemView>();
  if (operation.mode === 'update') {
    for (const item of snapshot.items) byKey.set(item.key, cloneItem(item));
  }

  let nextCreatedOrder = operation.mode === 'rewrite'
    ? order.operationIndex * 10_000
    : maxCreatedOrder(byKey) + 1;
  let activeKeepKey: string | undefined;

  operation.items.forEach((input, index) => {
    const key = titleKey(input.title);
    if (input.delete === true) {
      byKey.delete(key);
      return;
    }

    const existing = byKey.get(key);
    const status = input.status ?? existing?.status ?? 'pending';
    const item: TaskListItemView = {
      key,
      title: input.title,
      description: input.description ?? existing?.description,
      activeForm: input.activeForm ?? existing?.activeForm,
      status,
      createdOrder: existing?.createdOrder ?? nextCreatedOrder++,
      updatedOrder: order.operationIndex * 10_000 + index,
      sourceToolCallId: order.toolCallId
    };
    byKey.set(key, item);
    if (status === 'in_progress') activeKeepKey = key;
  });

  if (activeKeepKey) {
    for (const [key, item] of byKey) {
      if (key === activeKeepKey || item.status !== 'in_progress') continue;
      byKey.set(key, {
        ...item,
        status: 'pending',
        updatedOrder: order.operationIndex * 10_000 + operation.items.length
      });
    }
  }

  return snapshotFromItems([...byKey.values()]);
}

function taskListChangesForOperation(
  before: TaskListSnapshotView,
  after: TaskListSnapshotView,
  operation: TaskListToolOperationRecord
): TaskListChangeItemView[] {
  if (operation.mode === 'rewrite') {
    return after.items.map((item) => ({ ...cloneItem(item), changeKind: 'rewritten' }));
  }

  const beforeByKey = new Map(before.items.map((item) => [item.key, item]));
  const afterByKey = new Map(after.items.map((item) => [item.key, item]));
  const changes: TaskListChangeItemView[] = [];

  for (const input of operation.items) {
    const key = titleKey(input.title);
    const previous = beforeByKey.get(key);
    if (input.delete === true) {
      changes.push({
        ...(previous ? cloneItem(previous) : placeholderDeletedItem(input, changes.length)),
        deleted: true,
        changeKind: 'deleted',
        ...(previous?.status ? { previousStatus: previous.status } : {})
      });
      continue;
    }

    const next = afterByKey.get(key);
    if (!next) continue;
    changes.push({
      ...cloneItem(next),
      changeKind: changeKindFor(previous, next),
      ...(previous && previous.status !== next.status ? { previousStatus: previous.status } : {})
    });
  }

  return changes;
}

function changeKindFor(previous: TaskListItemView | undefined, next: TaskListItemView): TaskListChangeKind {
  if (!previous) return 'added';
  if (previous.status !== next.status) return next.status === 'completed' ? 'completed' : 'status_changed';
  return 'updated';
}

function placeholderDeletedItem(input: TaskListToolItemRecord, index: number): TaskListItemView {
  return {
    key: titleKey(input.title),
    title: input.title,
    description: input.description,
    activeForm: input.activeForm,
    status: 'cancelled',
    createdOrder: index,
    updatedOrder: index
  };
}

export function emptyTaskListSnapshot(): TaskListSnapshotView {
  return snapshotFromItems([]);
}

const applyTaskListOperation = applyTaskListOperationToSnapshot;

function snapshotFromItems(items: TaskListItemView[]): TaskListSnapshotView {
  const sorted = [...items].sort((left, right) => left.createdOrder - right.createdOrder || left.title.localeCompare(right.title));
  const stats = computeStats(sorted);
  const activeItem = sorted.find((item) => item.status === 'in_progress');
  return { items: sorted, stats, ...(activeItem ? { activeItem } : {}) };
}

function computeStats(items: readonly TaskListItemView[]): TaskListStatsView {
  const stats: TaskListStatsView = {
    total: items.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
    open: 0
  };
  for (const item of items) {
    if (item.status === 'pending') stats.pending += 1;
    if (item.status === 'in_progress') stats.inProgress += 1;
    if (item.status === 'completed') stats.completed += 1;
    if (item.status === 'blocked') stats.blocked += 1;
    if (item.status === 'cancelled') stats.cancelled += 1;
    if (!TERMINAL_STATUSES.has(item.status)) stats.open += 1;
  }
  return stats;
}

function cloneSnapshot(snapshot: TaskListSnapshotView): TaskListSnapshotView {
  return snapshotFromItems(snapshot.items.map(cloneItem));
}

function cloneItem(item: TaskListItemView): TaskListItemView {
  return {
    key: item.key,
    title: item.title,
    description: item.description,
    activeForm: item.activeForm,
    status: item.status,
    createdOrder: item.createdOrder,
    updatedOrder: item.updatedOrder,
    sourceToolCallId: item.sourceToolCallId
  };
}

function maxCreatedOrder(items: ReadonlyMap<string, TaskListItemView>): number {
  let max = -1;
  for (const item of items.values()) max = Math.max(max, item.createdOrder);
  return max;
}

function titleKey(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text : undefined;
}

function taskStatusValue(value: unknown): TaskListItemStatus | undefined {
  return typeof value === 'string' && (TASK_LIST_ITEM_STATUSES as readonly string[]).includes(value)
    ? value as TaskListItemStatus
    : undefined;
}

function parseJson(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return undefined;
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

