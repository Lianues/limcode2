import type { Component } from 'vue';
import type {
  AgentRunSourceLinkRecord,
  AgentRunTargetLinkRecord,
  CheckpointRecord,
  CheckpointTimelineAnchorRecord,
  MessageRecord,
  ShadowRepositoryRecord,
  ToolCallEventRecord,
  ToolCallRecord
} from '@shared/protocol';
import type { TaskListChangeItemView, TaskListItemView } from '@webview/components/taskList/taskListModel';

export interface ToolDisplayRow {
  label: string;
  value: string;
}

export interface ToolDisplayDiffFile {
  path: string;
  action?: string;
  added?: number;
  removed?: number;
  truncated?: boolean;
  text: string;
}

export interface ToolDisplayDiff {
  files: ToolDisplayDiffFile[];
  summary?: string;
}

export interface ToolDisplaySection {
  kind: 'input' | 'output';
  title: string;
  text?: string;
  rows?: ToolDisplayRow[];
  rowStyle?: 'keyValue' | 'lineNumber';
  diff?: ToolDisplayDiff;
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
  checkpoints?: CheckpointRecord[];
  checkpointTimelineAnchors?: CheckpointTimelineAnchorRecord[];
  shadowRepositories?: ShadowRepositoryRecord[];
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
  headerIcon?: Component;
  headerActions: ToolHeaderAction[];
}

export type ToolDisplayResolver = (context: ToolDisplayContext) => Partial<ToolDisplayResult> | undefined;
