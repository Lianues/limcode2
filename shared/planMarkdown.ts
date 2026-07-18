import type { TaskListToolOperationRecord } from './protocol';
import {
  taskListDisplayItemsFromOperation,
  taskListStatusLabel,
  type TaskListChangeItemView
} from './taskListProjection';

export interface PlanMarkdownInput {
  plan: string;
  taskList?: TaskListToolOperationRecord;
  statusLabel?: string;
  taskListTitle?: string;
  title?: string;
}

export function renderPlanMarkdown(input: PlanMarkdownInput): string {
  const title = input.title?.trim() || 'Plan';
  const statusLabel = input.statusLabel?.trim();
  const lines: string[] = [
    `# ${singleLineMarkdown(title)}`,
    ''
  ];

  if (statusLabel) {
    lines.push(`> 状态：${singleLineMarkdown(statusLabel)}`, '');
  }

  const body = input.plan.trim();
  lines.push(body || '_Plan 内容为空。_', '');

  lines.push(`# ${singleLineMarkdown(input.taskListTitle?.trim() || defaultTaskListTitle(input.taskList))}`, '');
  if (!input.taskList) {
    lines.push('_未提供任务清单。_');
    return normalizeMarkdownLines(lines);
  }

  const items = taskListDisplayItemsFromOperation(input.taskList);
  if (items.length === 0) {
    lines.push('_未提供任务清单。_');
    return normalizeMarkdownLines(lines);
  }

  items.forEach((item, index) => {
    lines.push(taskListItemMarkdown(item, index));
    if (item.description?.trim()) {
      lines.push(...taskListDescriptionMarkdown(item.description));
    }
  });
  return normalizeMarkdownLines(lines);
}

function defaultTaskListTitle(taskList: TaskListToolOperationRecord | undefined): string {
  return taskList?.mode === 'update' ? '任务清单更新' : '任务清单';
}

function taskListItemMarkdown(item: TaskListChangeItemView, index: number): string {
  const checkbox = item.status === 'completed' ? 'x' : ' ';
  const status = item.deleted ? `${taskListStatusLabel(item.status)} / 已删除` : taskListStatusLabel(item.status);
  return `${index + 1}. [${checkbox}] ${singleLineMarkdown(item.title)}（${status}）`;
}

function taskListDescriptionMarkdown(description: string): string[] {
  return description
    .trim()
    .split(/\r?\n/)
    .map((line, index) => index === 0 ? `   - ${line.trim()}` : `     ${line.trim()}`);
}

function singleLineMarkdown(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function normalizeMarkdownLines(lines: string[]): string {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
