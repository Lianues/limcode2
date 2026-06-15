import type { MessageRecord, ToolCallEventRecord, ToolCallRecord } from '@shared/protocol';
import type { TaskListChangeItemView, TaskListItemView } from '@webview/components/taskList/taskListModel';

export interface ToolDisplayRow {
  label: string;
  value: string;
}

export interface ToolDisplaySection {
  kind: 'input' | 'output';
  title: string;
  text?: string;
  rows?: ToolDisplayRow[];
  rowStyle?: 'keyValue' | 'lineNumber';
  taskList?: ToolDisplayTaskList;
}

export interface ToolDisplayTaskList {
  items: Array<TaskListItemView | TaskListChangeItemView>;
  showChange?: boolean;
  emptyText?: string;
}

export interface ToolDisplayContext {
  toolName: string;
  args: unknown;
  result?: unknown;
  progress?: unknown;
  events: ToolCallEventRecord[];
  toolCall?: ToolCallRecord;
  messages?: MessageRecord[];
  toolCalls?: ToolCallRecord[];
  currentConversationId?: string;
  stringifyValue(value: unknown): string;
}

export interface ToolDisplayResult {
  inputSections: ToolDisplaySection[];
  outputSections: ToolDisplaySection[];
}

export type ToolDisplayResolver = (context: ToolDisplayContext) => Partial<ToolDisplayResult> | undefined;
