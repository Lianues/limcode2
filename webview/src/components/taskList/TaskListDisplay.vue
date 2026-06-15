<script setup lang="ts">
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import {
  taskListChangeLabel,
  taskListStatusLabel,
  type TaskListChangeItemView,
  type TaskListItemView
} from './taskListModel';

type TaskListDisplayDensity = 'compact' | 'normal';

type TaskListDisplayItem = TaskListItemView | TaskListChangeItemView;

const props = withDefaults(defineProps<{
  items: readonly TaskListDisplayItem[];
  density?: TaskListDisplayDensity;
  showDescription?: boolean;
  showChange?: boolean;
  emptyText?: string;
}>(), {
  density: 'normal',
  showDescription: true,
  showChange: false,
  emptyText: '当前没有任务。'
});

function itemClasses(item: TaskListDisplayItem): Array<string | Record<string, boolean>> {
  return [
    `status-${item.status}`,
    {
      'is-deleted': isDeleted(item),
      'has-change': !!changeKind(item)
    }
  ];
}

function isDeleted(item: TaskListDisplayItem): boolean {
  return 'deleted' in item && item.deleted === true;
}

function changeKind(item: TaskListDisplayItem): TaskListChangeItemView['changeKind'] | undefined {
  return 'changeKind' in item ? item.changeKind : undefined;
}

function previousStatus(item: TaskListDisplayItem) {
  return 'previousStatus' in item ? item.previousStatus : undefined;
}

function statusLabel(item: TaskListDisplayItem): string {
  return isDeleted(item) ? '已删除' : taskListStatusLabel(item.status);
}

function statusTitle(item: TaskListDisplayItem): string {
  const previous = previousStatus(item);
  if (!previous || previous === item.status || isDeleted(item)) return statusLabel(item);
  return `${taskListStatusLabel(previous)} → ${taskListStatusLabel(item.status)}`;
}

function changeLabel(item: TaskListDisplayItem): string | undefined {
  const kind = changeKind(item);
  return kind ? taskListChangeLabel(kind) : undefined;
}

function showActiveForm(item: TaskListDisplayItem): boolean {
  return !isDeleted(item) && item.status === 'in_progress' && !!item.activeForm;
}
</script>

<template>
  <div class="task-list-display" :class="[`density-${props.density}`]">
    <p v-if="!items.length" class="task-list-empty">{{ emptyText }}</p>
    <ul v-else class="task-list-items">
      <li
        v-for="(item, index) in items"
        :key="`${item.key}-${changeKind(item) ?? 'item'}-${index}`"
        class="task-list-item"
        :class="itemClasses(item)"
      >
        <LcCheckbox
          class="task-list-check"
          presentation
          size="sm"
          :model-value="item.status === 'completed' && !isDeleted(item)"
          :disabled="isDeleted(item) || item.status === 'cancelled'"
        />
        <span class="task-list-status-dot" aria-hidden="true"></span>
        <div class="task-list-item-main">
          <div class="task-list-item-line">
            <span class="task-list-item-title" :title="item.title">{{ item.title }}</span>
            <span v-if="showChange && changeLabel(item)" class="task-list-change-badge">
              {{ changeLabel(item) }}
            </span>
            <span class="task-list-status-badge" :title="statusTitle(item)">{{ statusLabel(item) }}</span>
          </div>
          <p v-if="showDescription && item.description" class="task-list-item-description">
            {{ item.description }}
          </p>
          <p v-if="showActiveForm(item)" class="task-list-item-active">
            {{ item.activeForm }}
          </p>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.task-list-display {
  min-width: 0;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
}

.task-list-empty {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.task-list-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.task-list-display.density-compact .task-list-items {
  gap: 4px;
}

.task-list-item {
  display: grid;
  grid-template-columns: 14px 7px minmax(0, 1fr);
  align-items: start;
  column-gap: 7px;
  min-width: 0;
  color: var(--vscode-foreground);
}

.task-list-display.density-compact .task-list-item {
  grid-template-columns: 14px 6px minmax(0, 1fr);
  column-gap: 6px;
}

.task-list-check {
  margin-top: 2px;
}

.task-list-status-dot {
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 62%, transparent);
}

.task-list-item.status-in_progress .task-list-status-dot {
  background: var(--vscode-editorWarning-foreground, #cca700);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 18%, transparent);
}

.task-list-item.status-completed .task-list-status-dot {
  background: var(--vscode-testing-iconPassed, #4caf50);
}

.task-list-item.status-blocked .task-list-status-dot {
  background: var(--vscode-errorForeground, #f14c4c);
}

.task-list-item.status-cancelled .task-list-status-dot,
.task-list-item.is-deleted .task-list-status-dot {
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 40%, transparent);
}

.task-list-item-main {
  min-width: 0;
}

.task-list-item-line {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.task-list-item-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.task-list-item.status-completed .task-list-item-title,
.task-list-item.status-cancelled .task-list-item-title,
.task-list-item.is-deleted .task-list-item-title {
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 78%, var(--vscode-editor-background) 22%);
}

.task-list-item.is-deleted .task-list-item-title {
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}

.task-list-status-badge,
.task-list-change-badge {
  flex: 0 0 auto;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  padding: 0 5px;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  font-size: var(--font-size-xs);
  line-height: 16px;
  white-space: nowrap;
}

.task-list-change-badge {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}

.task-list-item.status-in_progress .task-list-status-badge {
  color: var(--vscode-editorWarning-foreground, #cca700);
  border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 42%, var(--vscode-panel-border));
}

.task-list-item.status-completed .task-list-status-badge {
  color: var(--vscode-testing-iconPassed, #4caf50);
  border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #4caf50) 42%, var(--vscode-panel-border));
}

.task-list-item.status-blocked .task-list-status-badge {
  color: var(--vscode-errorForeground, #f14c4c);
  border-color: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 42%, var(--vscode-panel-border));
}

.task-list-item-description,
.task-list-item-active {
  margin: 2px 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.task-list-display.density-compact .task-list-item-description {
  display: none;
}

.task-list-item-active {
  color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 78%, var(--vscode-descriptionForeground) 22%);
}
</style>
