<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconTool } from '@tabler/icons-vue';
import type { FunctionCallPart, ToolCallRecord, ToolCallStatus } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import ContentBlockSection from '../ContentBlockSection.vue';
import CollapsibleContentBlock from '../CollapsibleContentBlock.vue';

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
const outputText = computed(() => {
  const result = toolCall.value?.result;
  if (result !== undefined) return stringifyToolResult(result);
  const progress = toolCall.value?.progress;
  return progress !== undefined ? stringifyValue(progress) : '';
});
const hasOutput = computed(() => Boolean(outputText.value.trim()));
const hasDetails = computed(() => hasArgs.value || hasOutput.value || Boolean(toolCall.value?.error));
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

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringifyToolResult(value: unknown): string {
  if (isRecord(value) && typeof value.output === 'string') {
    return stringifyPossiblyJson(value.output);
  }
  return stringifyValue(value);
}

function stringifyPossiblyJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
  <CollapsibleContentBlock
    v-model:expanded="expanded"
    class="tool-call-card"
    :class="toolCall ? `status-${toolCall.status}` : undefined"
    kind="input"
    :collapsible="hasDetails"
    :aria-label="toggleLabel"
  >
    <template #icon>
      <IconTool stroke="2" aria-hidden="true" />
    </template>
    <template #summary>
      <span class="part-card-name">{{ part.functionCall.name }}</span>
    </template>
    <template #trail>
      <span class="part-card-status">{{ statusLabel }}</span>
      <span v-if="durationLabel" class="part-card-meta">{{ durationLabel }}</span>
    </template>

    <div class="part-card-details">
      <ContentBlockSection v-if="hasArgs" kind="input" title="输入" :text="argsText" />
      <ContentBlockSection v-if="hasOutput" kind="output" title="输出" :text="outputText" />
      <p v-if="toolCall?.error" class="part-card-error">{{ toolCall.error }}</p>
    </div>
  </CollapsibleContentBlock>
</template>

<style scoped>
.tool-call-card {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  font-style: normal;
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
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.part-card-details {
  margin: 3px 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
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
