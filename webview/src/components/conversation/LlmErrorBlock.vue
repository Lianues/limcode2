<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconAlertTriangle, IconCheck, IconCopy, IconEye, IconEyeOff } from '@tabler/icons-vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import type { LlmErrorBlockRecord } from '@webview/stores/useConversationUiStore';

const props = defineProps<{
  block: LlmErrorBlockRecord;
}>();

const emit = defineEmits<{
  (event: 'close', id: string): void;
  (event: 'cancel-retry', block: LlmErrorBlockRecord): void;
}>();

const rawOpen = ref(false);
const rawScroller = ref<HTMLElement | null>(null);
const copied = ref(false);

const rawText = computed(() => stringifyRaw(props.block.rawError ?? { message: props.block.message }));
const retryLabel = computed(() => {
  const attempt = props.block.retryAttempt;
  const max = props.block.retryMaxAttempts;
  if (attempt === undefined) return '自动重试中';
  if (max === -1) return `自动重试 ${attempt}/∞`;
  if (max !== undefined) return `自动重试 ${attempt}/${max}`;
  return `自动重试 ${attempt}`;
});
const statusLabel = computed(() => {
  switch (props.block.status) {
    case 'retrying':
      return props.block.cancelPending ? '正在停止自动重试' : retryLabel.value;
    case 'cancelled':
      return '自动重试已取消';
    case 'resolved':
      return '自动重试成功';
    case 'failed':
      return '请求失败';
  }
});
const statusClass = computed(() => `is-${props.block.status}`);
const rawToggleLabel = computed(() => rawOpen.value ? '收起报错完整响应' : '查看报错完整响应');

function toggleRaw(): void {
  rawOpen.value = !rawOpen.value;
}

function close(): void {
  emit('close', props.block.id);
}

function cancelRetry(): void {
  if (props.block.status !== 'retrying' || props.block.cancelPending) return;
  emit('cancel-retry', props.block);
}

async function copyRaw(): Promise<void> {
  if (!rawText.value) return;
  const ok = await writeClipboard(rawText.value);
  if (!ok) return;
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1200);
}

function stringifyRaw(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  return writeClipboardFallback(text);
}

function writeClipboardFallback(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}
</script>

<template>
  <section class="llm-error-block" :class="statusClass" aria-label="LLM 请求报错">
    <header class="llm-error-header">
      <span class="llm-error-icon" aria-hidden="true">
        <IconAlertTriangle stroke="2" />
      </span>
      <div class="llm-error-title-group">
        <span class="llm-error-title">LLM 请求报错</span>
        <span class="llm-error-status">{{ statusLabel }}</span>
      </div>
      <button type="button" class="llm-error-close" aria-label="关闭错误提示" @click="close">
        <svg class="llm-error-close-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </header>

    <p class="llm-error-message">{{ block.message }}</p>

    <div class="llm-error-actions">
      <button type="button" class="llm-error-button" @click="toggleRaw">
        <IconEyeOff v-if="rawOpen" stroke="2" aria-hidden="true" />
        <IconEye v-else stroke="2" aria-hidden="true" />
        <span>{{ rawToggleLabel }}</span>
      </button>
      <button v-if="rawOpen" type="button" class="llm-error-button" @click="copyRaw">
        <IconCheck v-if="copied" stroke="2" aria-hidden="true" />
        <IconCopy v-else stroke="2" aria-hidden="true" />
        <span>{{ copied ? '已复制' : '复制' }}</span>
      </button>
      <button
        v-if="block.status === 'retrying'"
        type="button"
        class="llm-error-button"
        :disabled="block.cancelPending"
        @click="cancelRetry"
      >
        <span>{{ block.cancelPending ? '正在停止…' : '停止本次自动重试' }}</span>
      </button>
    </div>

    <div v-if="rawOpen" class="llm-error-raw-shell">
      <div ref="rawScroller" class="llm-error-raw-scroll">
        <pre class="llm-error-raw">{{ rawText }}</pre>
      </div>
      <AdvancedScrollbar class="llm-error-scrollbar" :scroller="rawScroller" variant="minimal" :refresh-key="rawText" />
    </div>
  </section>
</template>

<style scoped>
.llm-error-block {
  position: relative;
  display: grid;
  gap: var(--space-2);
  margin: var(--space-2) 0;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 38%, var(--vscode-panel-border) 62%);
  border-left-width: 2px;
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-errorForeground) 6%);
  box-sizing: border-box;
}

.llm-error-header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
  padding-right: 30px;
}

.llm-error-icon {
  display: inline-flex;
  width: 18px;
  height: 18px;
  color: var(--vscode-errorForeground);
  flex: 0 0 auto;
}

.llm-error-icon svg {
  width: 18px;
  height: 18px;
}

.llm-error-title-group {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
}

.llm-error-title {
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
  line-height: 1.35;
}

.llm-error-status {
  display: inline-flex;
  align-items: center;
  justify-self: end;
  text-align: right;
  min-height: 18px;
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-errorForeground);
  background: transparent;
  font-size: var(--font-size-xs);
  line-height: 1.25;
}

.llm-error-block.is-resolved .llm-error-status {
  color: var(--vscode-descriptionForeground);
  border-color: transparent;
  background: transparent;
}

.llm-error-close {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  width: 26px;
  height: 26px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
  opacity: 0.72;
  cursor: pointer;
}

.llm-error-close:hover,
.llm-error-close:focus-visible {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground);
  opacity: 1;
  outline: none;
}

.llm-error-close-icon {
  display: block;
  width: 16px;
  height: 16px;
  color: currentColor;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.25;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 1;
  pointer-events: none;
}

.llm-error-close-icon path {
  stroke: currentColor;
  vector-effect: non-scaling-stroke;
}

.llm-error-message {
  margin: 0;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.llm-error-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.llm-error-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease;
}

.llm-error-button:hover:not(:disabled),
.llm-error-button:focus-visible:not(:disabled) {
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.llm-error-button:disabled {
  opacity: 0.55;
  cursor: default;
}

.llm-error-button svg {
  width: 14px;
  height: 14px;
}

.llm-error-raw-shell {
  position: relative;
  max-height: 260px;
  min-height: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 86%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
}

.llm-error-raw-scroll {
  max-height: 260px;
  overflow: auto;
  padding: var(--space-3) 14px var(--space-3) var(--space-3);
  scrollbar-width: none;
  box-sizing: border-box;
}

.llm-error-raw-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.llm-error-raw {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.llm-error-block :deep(.advanced-scrollbar.llm-error-scrollbar) {
  top: 4px;
  right: 2px;
  bottom: 4px;
  width: 8px;
}
</style>
