<script setup lang="ts">
import { computed } from 'vue';
import type { CheckpointRecord } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';

const props = defineProps<{ conversationId: string }>();
const clientState = useClientStateStore();

const checkpoints = computed<CheckpointRecord[]>(() =>
  clientState.checkpoints
    .filter((checkpoint) => checkpoint.conversationId === props.conversationId)
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
);

function statusLabel(status: CheckpointRecord['status']): string {
  switch (status) {
    case 'pending': return '创建中';
    case 'created': return '已创建';
    case 'skipped': return '已跳过';
    case 'failed': return '失败';
  }
}

function triggerLabel(trigger: CheckpointRecord['trigger']): string {
  switch (trigger) {
    case 'conversation_initial': return '初始存档';
    case 'user_message_before': return '用户消息前';
    case 'user_message_after': return '用户消息后';
    case 'llm_response_before': return '每次调用 AI 前';
    case 'llm_response_after': return '每次调用 AI 后';
    case 'tool_execution_before': return '工具执行前';
    case 'tool_execution_after': return '工具执行后';
    case 'agent_run_completed_before': return '整回合回复完成前';
    case 'agent_run_completed_after': return '整回合回复完成后';
    case 'manual': return '手动';
  }
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString();
}
</script>

<template>
  <section class="checkpoint-list-panel" aria-label="存档点记录">
    <header class="checkpoint-list-header">
      <div>
        <h3>存档点记录</h3>
        <p>存档点按创建时的对话归属路径记录；切换归属后旧记录仍保留原路径。</p>
      </div>
      <span class="checkpoint-count">{{ checkpoints.length }} 条</span>
    </header>

    <div v-if="checkpoints.length === 0" class="checkpoint-empty">
      当前对话还没有存档点记录。
    </div>

    <ol v-else class="checkpoint-list">
      <li v-for="checkpoint in checkpoints" :key="checkpoint.id" class="checkpoint-item" :class="`is-${checkpoint.status}`">
        <div class="checkpoint-main">
          <strong>{{ statusLabel(checkpoint.status) }}</strong>
          <span>{{ triggerLabel(checkpoint.trigger) }} · {{ formatTime(checkpoint.createdAt) }}</span>
        </div>
        <div class="checkpoint-path">{{ checkpoint.projectDisplayPath || checkpoint.projectUri }}</div>
        <div class="checkpoint-meta">
          <span v-if="checkpoint.commitSha">commit {{ checkpoint.commitSha.slice(0, 8) }}</span>
          <span v-if="checkpoint.fileCount !== undefined">{{ checkpoint.fileCount }} 文件</span>
          <span v-if="checkpoint.byteCount !== undefined">{{ Math.round(checkpoint.byteCount / 1024) }} KB</span>
          <span v-if="checkpoint.emptyDirectoryCount !== undefined">{{ checkpoint.emptyDirectoryCount }} 空目录</span>
        </div>
        <p v-if="checkpoint.message" class="checkpoint-message">{{ checkpoint.message }}</p>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.checkpoint-list-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
}

.checkpoint-list-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}

.checkpoint-list-header h3 {
  margin: 0;
  font-size: var(--font-size-md);
}

.checkpoint-list-header p,
.checkpoint-empty,
.checkpoint-message {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  margin: var(--space-1) 0 0;
}

.checkpoint-count {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.checkpoint-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.checkpoint-item {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.checkpoint-main,
.checkpoint-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}

.checkpoint-main span,
.checkpoint-meta {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.checkpoint-path {
  font-family: var(--vscode-editor-font-family);
  font-size: var(--font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
