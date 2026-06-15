import type { TaskListToolOperationRecord } from '@shared/protocol';
import {
  formatTaskListProgress,
  taskListDisplayItemsFromOperation,
  taskListOperationFromArgs,
  taskListOperationFromToolCall,
  taskListTimelineEntryForToolCall,
  type TaskListChangeItemView,
  type TaskListItemView
} from '@webview/components/taskList/taskListModel';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';

export const taskListToolDisplay: ToolDisplayResolver = (context) => {
  const operation = taskListOperationFromToolCall(context.toolCall, { allowArgsFallback: true })
    ?? taskListOperationFromArgs(context.args);
  if (!operation) return undefined;

  return {
    inputSections: inputSections(operation),
    outputSections: outputSections(operation, context)
  };
};

function inputSections(operation: TaskListToolOperationRecord): ToolDisplaySection[] {
  return [{
    kind: 'input',
    title: '任务清单操作',
    rows: [
      { label: 'mode', value: operation.mode === 'rewrite' ? 'rewrite · 重写完整清单' : 'update · 增量更新' },
      { label: 'items', value: `${operation.items.length} 项` }
    ],
    rowStyle: 'keyValue'
  }];
}

function outputSections(operation: TaskListToolOperationRecord, context: ToolDisplayContext): ToolDisplaySection[] {
  const entry = timelineEntry(context);
  const items = displayItems(operation, entry?.changes, entry?.snapshotAfter.items);
  const title = operation.mode === 'rewrite' ? '完整任务清单' : '任务清单变更';
  const emptyText = operation.mode === 'rewrite' ? '任务清单已清空。' : '没有可显示的变更。';

  return [{
    kind: 'output',
    title: entry ? `${title} · ${formatTaskListProgress(entry.snapshotAfter)}` : title,
    taskList: {
      items,
      showChange: operation.mode === 'update',
      emptyText
    }
  }];
}

function timelineEntry(context: ToolDisplayContext) {
  const toolCall = context.toolCall;
  const conversationId = context.currentConversationId;
  if (!toolCall || !conversationId || !context.messages || !context.toolCalls) return undefined;
  return taskListTimelineEntryForToolCall({
    messages: context.messages,
    toolCalls: context.toolCalls,
    conversationId,
    toolCallId: toolCall.id
  });
}

function displayItems(
  operation: TaskListToolOperationRecord,
  changes: TaskListChangeItemView[] | undefined,
  snapshotItems: TaskListItemView[] | undefined
): Array<TaskListItemView | TaskListChangeItemView> {
  if (operation.mode === 'rewrite') {
    return snapshotItems ?? taskListDisplayItemsFromOperation(operation).filter((item) => item.deleted !== true);
  }
  return changes ?? taskListDisplayItemsFromOperation(operation);
}
