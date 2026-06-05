<script setup lang="ts">
import { computed } from 'vue';
import type { FunctionCallPart, ToolCallRecord, ToolCallStatus } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';

const props = defineProps<{
  part: FunctionCallPart;
  messageId?: string;
}>();

const clientState = useClientStateStore();
const toolCall = computed<ToolCallRecord | undefined>(() => {
  const partId = props.part.id;
  if (!props.messageId || !partId) return undefined;
  return clientState.toolCalls.find(
    (call) => call.messageId === props.messageId && (call.id === partId || call.functionCallId === partId)
  );
});
const argsText = computed(() => stringifyValue(props.part.functionCall.args));
const statusLabel = computed(() => toolCall.value ? labelForStatus(toolCall.value.status) : '已请求');
const durationLabel = computed(() => {
  const duration = toolCall.value?.durationMs;
  if (duration === undefined) return undefined;
  return duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)}s`;
});

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function labelForStatus(status: ToolCallStatus): string {
  const labels: Record<ToolCallStatus, string> = {
    streaming: '生成中',
    queued: '排队中',
    awaiting_approval: '等待批准',
    executing: '执行中',
    awaiting_apply: '等待应用',
    success: '成功',
    warning: '警告',
    error: '失败'
  };
  return labels[status];
}
</script>

<template>
  <section class="part-card tool-call-card" :class="toolCall ? `status-${toolCall.status}` : undefined">
    <header class="part-card-header">
      <span class="part-card-title">工具调用</span>
      <span class="part-card-name">{{ part.functionCall.name }}</span>
      <span class="part-card-status">{{ statusLabel }}</span>
      <span v-if="durationLabel" class="part-card-meta">{{ durationLabel }}</span>
    </header>
    <pre v-if="argsText && argsText !== '{}'" class="part-card-code">{{ argsText }}</pre>
    <p v-if="toolCall?.error" class="part-card-error">{{ toolCall.error }}</p>
  </section>
</template>

<style scoped>
.part-card {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
}

.part-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.part-card-title {
  color: var(--vscode-descriptionForeground);
  flex: 0 0 auto;
}

.part-card-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.part-card-status,
.part-card-meta {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.part-card-meta {
  margin-left: 0;
}

.part-card-code {
  margin: 7px 0 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
}

.part-card-error {
  margin: 7px 0 0;
  color: var(--vscode-errorForeground);
}

.status-success .part-card-status {
  color: var(--vscode-testing-iconPassed, #4caf50);
}

.status-warning .part-card-status {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.status-error .part-card-status {
  color: var(--vscode-errorForeground);
}
</style>
