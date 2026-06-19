import type { Component } from 'vue';
import type {
  AgentRunSourceLinkRecord,
  AgentRunTargetLinkRecord,
  MessageRecord,
  ToolCallEventRecord,
  ToolCallRecord
} from '@shared/protocol';
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
  agentRunSourceLinks?: AgentRunSourceLinkRecord[];
  agentRunTargetLinks?: AgentRunTargetLinkRecord[];
  currentConversationId?: string;
  stringifyValue(value: unknown): string;
}

export interface ToolHeaderAction {
  id: string;
  label: string;
  title?: string;
  icon?: Component;
  disabled?: boolean;
  invoke(): void;
}

export interface ToolDisplayResult {
  inputSections: ToolDisplaySection[];
  outputSections: ToolDisplaySection[];
  headerActions: ToolHeaderAction[];
}

export type ToolDisplayResolver = (context: ToolDisplayContext) => Partial<ToolDisplayResult> | undefined;
