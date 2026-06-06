<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconChevronRight, IconTool } from '@tabler/icons-vue';
import type { FunctionCallPart, ToolCallRecord, ToolCallStatus } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';

const props = defineProps<{
  part: FunctionCallPart;
  messageId?: string;
}>();

const clientState = useClientStateStore();
const expanded = ref(false);
const toolCall = computed<ToolCallRecord | undefined>(() => {
  const partId = props.part.id;
  if (!props.messageId || !partId) return undefined;
  return clientState.toolCalls.find(
    (call) => call.messageId === props.messageId && (call.id === partId || call.functionCallId === partId)
  );
});
const argsText = computed(() => stringifyValue(props.part.functionCall.args));
const hasArgs = computed(() => {
  const text = argsText.value.trim();
  return Boolean(text && text !== '{}');
});
const hasDetails = computed(() => hasArgs.value || Boolean(toolCall.value?.error));
const statusLabel = computed(() => toolCall.value ? labelForStatus(toolCall.value.status) : '已请求');
const durationLabel = computed(() => {
  const duration = toolCall.value?.durationMs;
  if (duration === undefined) return undefined;
  return duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)}s`;
});
const toggleLabel = computed(() => {
  if (!hasDetails.value) return `工具调用 ${props.part.functionCall.name}`;
  return expanded.value ? '收起工具调用内容' : '展开工具调用内容';
});

function toggleExpanded(): void {
  if (!hasDetails.value) return;
  expanded.value = !expanded.value;
}

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
  <section class="tool-call-card" :class="toolCall ? `status-${toolCall.status}` : undefined">
    <button
      type="button"
      class="part-card-header"
      :class="{ 'is-empty': !hasDetails }"
      :aria-expanded="expanded"
      :aria-label="toggleLabel"
      @click="toggleExpanded"
    >
      <IconChevronRight
        class="part-card-chevron lc-collapse-chevron"
        :class="{ 'is-expanded': expanded }"
        stroke="2"
        aria-hidden="true"
      />
      <IconTool class="part-card-icon" stroke="2" aria-hidden="true" />
      <span class="part-card-name">{{ part.functionCall.name }}</span>
      <span class="part-card-status">{{ statusLabel }}</span>
      <span v-if="durationLabel" class="part-card-meta">{{ durationLabel }}</span>
    </button>
    <div
      v-if="hasDetails"
      class="part-card-content-shell lc-collapse-shell"
      :class="{ 'is-expanded': expanded }"
      :aria-hidden="!expanded"
    >
      <div class="part-card-content-frame lc-collapse-frame">
        <div class="part-card-details">
          <pre v-if="hasArgs" class="part-card-code">{{ argsText }}</pre>
          <p v-if="toolCall?.error" class="part-card-error">{{ toolCall.error }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tool-call-card {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  font-style: normal;
}

.part-card-header {
  width: 100%;
  min-width: 0;
  min-height: 0;
  padding: 4px 7px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  gap: 6px;
  color: inherit;
  background: var(--lc-content-input-background);
  cursor: pointer;
  text-align: left;
  line-height: 1.6;
}

.part-card-header:hover,
.part-card-header:focus-visible {
  color: var(--vscode-foreground);
  background: var(--lc-content-input-background);
}

.part-card-header:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 2px;
}

.part-card-header.is-empty {
  cursor: default;
}

.part-card-header.is-empty .part-card-chevron {
  opacity: 0.45;
}

.part-card-chevron,
.part-card-icon {
  width: 14px;
  height: 14px;
  color: var(--lc-content-icon-color);
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

.part-card-details {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  color: var(--vscode-descriptionForeground);
  background: var(--lc-content-input-background);
}

.part-card-code {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
}

.part-card-error {
  margin: 6px 0 0;
  color: var(--vscode-errorForeground);
}

.part-card-error:first-child {
  margin-top: 0;
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
