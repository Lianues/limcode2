<script setup lang="ts">
import { computed } from 'vue';
import { IconAlertTriangle, IconCheck, IconRefresh } from '@tabler/icons-vue';
import type { CompressionBlockStatus, LlmInvocationRecord } from '@shared/protocol';

const props = defineProps<{
  invocation?: LlmInvocationRecord;
  blockStatus?: CompressionBlockStatus;
}>();

const retryStatus = computed(() => props.invocation?.retryStatus);
const visible = computed(() => retryStatus.value !== undefined);
const active = computed(() => retryStatus.value === 'scheduled' || retryStatus.value === 'retrying');
const toneClass = computed(() => {
  switch (retryStatus.value) {
    case 'scheduled':
    case 'retrying':
      return 'is-active';
    case 'recovered':
      return 'is-recovered';
    case 'cancelled':
    case 'exhausted':
      return 'is-failed';
    default:
      return '';
  }
});
const attemptLabel = computed(() => formatAttempt(props.invocation?.retryAttempt, props.invocation?.retryMaxAttempts));
const title = computed(() => {
  const suffix = attemptLabel.value ? ` ${attemptLabel.value}` : '';
  switch (retryStatus.value) {
    case 'scheduled':
      return `等待自动重试${suffix}`;
    case 'retrying':
      return `正在自动重试${suffix}`;
    case 'cancelled':
      return '自动重试已取消';
    case 'recovered':
      return props.blockStatus === 'complete' ? `重试后压缩完成${suffix}` : `自动重试成功${suffix}`;
    case 'exhausted':
      return `自动重试后仍失败${suffix}`;
    default:
      return '自动重试';
  }
});
const description = computed(() => {
  switch (retryStatus.value) {
    case 'scheduled': {
      const delay = formatDelay(props.invocation?.retryDelayMs);
      return delay ? `上次请求报错，约 ${delay} 后重新发起压缩。` : '上次请求报错，正在等待重新发起压缩。';
    }
    case 'retrying':
      return '正在重新请求压缩结果，压缩块会在成功后自动恢复。';
    case 'cancelled':
      return '已停止本次自动重试，可手动重新生成压缩块。';
    case 'recovered':
      return '之前的报错已通过自动重试恢复。';
    case 'exhausted':
      return '已达到最大重试次数，本次压缩仍然失败。';
    default:
      return '';
  }
});
const errorText = computed(() => {
  const message = props.invocation?.retryMessage?.trim();
  if (!message || retryStatus.value === 'recovered') return '';
  return message.length > 220 ? `${message.slice(0, 220)}…` : message;
});

function formatAttempt(attempt: number | undefined, max: number | undefined): string {
  if (attempt === undefined) return '';
  if (max === -1) return `${attempt}/∞`;
  if (max !== undefined) return `${attempt}/${max}`;
  return `${attempt}`;
}

function formatDelay(delayMs: number | undefined): string {
  if (delayMs === undefined || !Number.isFinite(delayMs) || delayMs <= 0) return '';
  if (delayMs < 1000) return `${Math.round(delayMs)}ms`;
  const seconds = delayMs / 1000;
  return seconds >= 10 ? `${Math.round(seconds)} 秒` : `${Math.round(seconds * 10) / 10} 秒`;
}
</script>

<template>
  <div v-if="visible" class="compression-retry-status" :class="toneClass" aria-live="polite">
    <span class="retry-glyph" :class="{ 'is-spinning': active }" aria-hidden="true">
      <IconRefresh v-if="active" stroke="2" />
      <IconCheck v-else-if="retryStatus === 'recovered'" stroke="2" />
      <IconAlertTriangle v-else stroke="2" />
    </span>
    <span class="retry-copy">
      <span class="retry-title">{{ title }}</span>
      <span class="retry-description">{{ description }}</span>
      <span v-if="errorText" class="retry-error">{{ errorText }}</span>
    </span>
  </div>
</template>

<style scoped>
.compression-retry-status {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: flex-start;
  margin: 0 0 0 calc(16px + var(--space-2));
  padding: var(--space-2);
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, var(--vscode-editorWarning-foreground, #cca700) 18%);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-editorWarning-foreground, #cca700) 5%);
  color: var(--vscode-foreground);
  box-sizing: border-box;
}

.compression-retry-status.is-recovered {
  border-color: color-mix(in srgb, var(--vscode-panel-border) 88%, var(--vscode-descriptionForeground) 12%);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.compression-retry-status.is-failed {
  border-color: color-mix(in srgb, var(--vscode-errorForeground) 34%, var(--vscode-panel-border) 66%);
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-errorForeground) 5%);
}

.retry-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.is-recovered .retry-glyph {
  color: var(--vscode-descriptionForeground);
}

.is-failed .retry-glyph {
  color: var(--vscode-errorForeground);
}

.retry-glyph svg {
  width: 15px;
  height: 15px;
}

.retry-glyph.is-spinning svg {
  animation: compression-retry-spin 0.95s linear infinite;
}

.retry-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.retry-title {
  color: var(--vscode-foreground);
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1.35;
}

.retry-description,
.retry-error {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.retry-error {
  color: color-mix(in srgb, var(--vscode-errorForeground) 82%, var(--vscode-descriptionForeground) 18%);
}

@keyframes compression-retry-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
