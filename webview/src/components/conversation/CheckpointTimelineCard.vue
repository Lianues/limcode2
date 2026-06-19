<script setup lang="ts">
import { computed } from 'vue';
import { IconGitCommit } from '@tabler/icons-vue';
import type { CheckpointRecord, CheckpointTimelineAnchorRecord } from '@shared/protocol';
import { checkpointTimelineActions } from './checkpointTimelineActions';

const props = defineProps<{
  checkpoint: CheckpointRecord;
  anchor: CheckpointTimelineAnchorRecord;
  messageFloorNumber: number;
  phase?: 'stable' | 'entering' | 'exiting';
}>();

const actions = checkpointTimelineActions();

const statusLabel = computed(() => {
  switch (props.checkpoint.status) {
    case 'created': return '已创建';
    case 'skipped': return '已跳过';
    case 'failed': return '失败';
  }
});

const triggerLabel = computed(() => {
  switch (props.checkpoint.trigger) {
    case 'user_message_after': return '用户消息后';
    case 'llm_response_after': return 'AI 回复后';
    case 'tool_execution_before': return '工具执行前';
    case 'tool_execution_after': return '工具执行后';
    case 'agent_run_completed_after': return '任务完成后';
    case 'manual': return '手动';
  }
});

const metaItems = computed(() => {
  const items: string[] = [];
  if (props.checkpoint.commitSha) items.push(`commit ${props.checkpoint.commitSha.slice(0, 8)}`);
  if (props.checkpoint.fileCount !== undefined) items.push(`${props.checkpoint.fileCount} 文件`);
  if (props.checkpoint.byteCount !== undefined) items.push(`${Math.round(props.checkpoint.byteCount / 1024)} KB`);
  return items;
});

function formatTime(value: number): string {
  return new Date(value).toLocaleString();
}
</script>

<template>
  <section class="checkpoint-timeline-card" :class="[`is-${checkpoint.status}`, phase ? `is-${phase}` : undefined]">
    <div class="checkpoint-card-main">
      <header class="checkpoint-card-header">
        <div class="checkpoint-card-title-row">
          <span class="checkpoint-title">存档点</span>
          <span class="checkpoint-status">{{ statusLabel }}</span>
          <span class="checkpoint-summary">{{ triggerLabel }} · {{ formatTime(checkpoint.createdAt) }}</span>
          <span class="checkpoint-floor">#{{ messageFloorNumber }}</span>
        </div>
        <div class="checkpoint-actions" aria-label="存档点操作">
          <button
            v-for="action in actions"
            :key="action.id"
            type="button"
            class="checkpoint-action-button"
            :disabled="!action.enabled({ checkpoint, anchor })"
            :title="action.description"
            @click="action.run({ checkpoint, anchor })"
          >
            {{ action.label }}
          </button>
        </div>
      </header>
      <div class="checkpoint-card-detail-row">
        <span class="checkpoint-path">{{ checkpoint.projectDisplayPath || checkpoint.projectUri }}</span>
        <span v-for="item in metaItems" :key="item" class="checkpoint-meta-item">
          <IconGitCommit v-if="item.startsWith('commit ')" class="checkpoint-meta-icon" stroke="2" aria-hidden="true" />
          <span>{{ item }}</span>
        </span>
        <span v-if="checkpoint.message" class="checkpoint-message">{{ checkpoint.message }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.checkpoint-timeline-card {
  display: flex;
  padding: 6px var(--conversation-content-padding-right, calc(var(--space-4) + 24px))
    6px var(--conversation-content-padding-left, var(--space-4));
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  box-sizing: border-box;
}

.checkpoint-timeline-card.is-exiting {
  pointer-events: none;
  animation: lc-message-exit-right var(--lc-message-exit-duration) var(--lc-motion-exit-standard) forwards;
}

.checkpoint-card-main {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.checkpoint-card-header,
.checkpoint-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.checkpoint-card-header {
  justify-content: space-between;
  min-width: 0;
}

.checkpoint-card-title-row,
.checkpoint-card-detail-row {
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.checkpoint-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  line-height: 18px;
}

.checkpoint-status,
.checkpoint-floor,
.checkpoint-summary,
.checkpoint-meta-item,
.checkpoint-message {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 16px;
}

.checkpoint-path {
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family);
  font-size: var(--font-size-xs);
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.checkpoint-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.checkpoint-meta-icon {
  width: 12px;
  height: 12px;
}

.checkpoint-action-button {
  min-height: 20px;
  padding: 0 6px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
  font-size: var(--font-size-xs);
  line-height: 18px;
  cursor: pointer;
}

.checkpoint-action-button:hover:not(:disabled),
.checkpoint-action-button:focus-visible {
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  outline: none;
}

.checkpoint-action-button:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
