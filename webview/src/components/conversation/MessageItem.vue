<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { IconCheck, IconCopy, IconEdit, IconRefresh, IconTrash } from '@tabler/icons-vue';
import { isVisibleTextPart, type MessageRecord, type MessageStopReason } from '@shared/protocol';
import RichContentView from '@webview/components/content/RichContentView.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';

const props = withDefaults(
  defineProps<{
    message: MessageRecord;
    deleteCount?: number;
    deleting?: boolean;
    entering?: boolean;
  }>(),
  { deleteCount: 1, deleting: false, entering: false }
);

const emit = defineEmits<{
  (event: 'edit-message', message: MessageRecord): void;
  (event: 'retry-from', message: MessageRecord): void;
  (event: 'delete-from', message: MessageRecord): void;
}>();

const roleLabel = computed(() => (props.message.role === 'user' ? '你' : 'AI'));
const streaming = computed(() => props.message.status === 'streaming');
const copied = ref(false);
const confirmRetryOpen = ref(false);
const confirmDeleteOpen = ref(false);
const deleteDescriptionHtml = computed(
  () => `将删除这条消息以及它之后的所有共 ${props.deleteCount} 条消息，此操作<strong>无法撤销</strong>。`
);
const retryDescriptionHtml = computed(
  () => `确定要重试此消息吗？这将删除此消息及后续共 ${props.deleteCount} 条消息，然后重新请求 AI 响应。此操作<strong>不可撤销</strong>。`
);
const messageText = computed(() =>
  props.message.content.parts
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join('')
);

let copiedResetTimer: number | undefined;

const deleteConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '删除' }
];
const retryConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '确认' }
];

onBeforeUnmount(() => {
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
});

const stopReasonLabel = computed<string | undefined>(() => {
  switch (props.message.stopReason) {
    case 'paused':
      return '已暂停';
    case 'cancelled':
      return '已终止';
    case 'replaced':
      return '已替换';
    case 'stale':
      return '已失效';
    default:
      return undefined;
  }
});

const stopReasonClass = computed<string | undefined>(() => {
  return props.message.stopReason ? `stop-${props.message.stopReason}` : undefined;
});

const stopReasonTitle = computed(() => titleForStopReason(props.message.stopReason));

function titleForStopReason(reason: MessageStopReason | undefined): string | undefined {
  switch (reason) {
    case 'paused':
      return '当前回复已暂停，可稍后恢复继续执行。';
    case 'cancelled':
      return '当前回复已被手动终止。';
    case 'replaced':
      return '当前回复已被新的任务替换。';
    case 'stale':
      return '当前回复已因上下文变化而失效。';
    default:
      return undefined;
  }
}

async function copyMessage(): Promise<void> {
  const text = messageText.value;
  if (!text) return;

  const ok = await writeClipboard(text);
  if (!ok) return;

  copied.value = true;
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
  copiedResetTimer = window.setTimeout(() => {
    copied.value = false;
    copiedResetTimer = undefined;
  }, 1400);
}

async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // VS Code Webview / 老环境可能拒绝 Clipboard API，继续尝试 textarea fallback。
    }
  }

  return writeClipboardFallback(text);
}

function writeClipboardFallback(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';

  try {
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch (error) {
    console.warn('[LimCode] Failed to copy message.', error);
    return false;
  } finally {
    textarea.remove();
  }
}

function openDeleteConfirm(): void {
  confirmDeleteOpen.value = true;
}

function editMessage(): void {
  emit('edit-message', props.message);
}

function openRetryConfirm(): void {
  confirmRetryOpen.value = true;
}

function cancelRetry(): void {
  confirmRetryOpen.value = false;
}

function confirmRetry(): void {
  emit('retry-from', props.message);
  confirmRetryOpen.value = false;
}

function cancelDelete(): void {
  confirmDeleteOpen.value = false;
}

function confirmDelete(): void {
  emit('delete-from', props.message);
  confirmDeleteOpen.value = false;
}

function onDeleteConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') cancelDelete();
  if (action.key === 'confirm') confirmDelete();
}

function onRetryConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') cancelRetry();
  if (action.key === 'confirm') confirmRetry();
}
</script>

<template>
  <article class="message-floor" :class="[message.role, { streaming, 'is-deleting': deleting, 'is-entering': entering }]" :data-scroll-marker-id="message.id">
    <div class="floor-container">
      <div class="floor-content-column">
        <header class="floor-header">
          <span class="role-chip" :class="message.role === 'user' ? 'user' : 'assistant'">
            <span class="role-dot" aria-hidden="true"></span>
            <span class="floor-role-name">{{ roleLabel }}</span>
          </span>
          <span v-if="streaming" class="floor-status-badge is-streaming">正在输入</span>
          <span
            v-else-if="stopReasonLabel"
            class="floor-status-badge is-stop"
            :class="stopReasonClass"
            :title="stopReasonTitle"
          >
            {{ stopReasonLabel }}
          </span>
        </header>
        <div class="floor-body">
          <RichContentView
            :parts="message.content.parts"
            :markdown="message.role !== 'user'"
            :streaming="streaming"
          />
        </div>
      </div>
    </div>
    <div class="message-actions" aria-label="消息操作">
      <button
        v-if="message.role === 'user'"
        type="button"
        class="message-action-button"
        aria-label="编辑消息"
        title="编辑消息"
        @click="editMessage"
      >
        <IconEdit class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        v-if="message.role !== 'user'"
        type="button"
        class="message-action-button"
        aria-label="重试此消息"
        title="重试此消息"
        @click="openRetryConfirm"
      >
        <IconRefresh class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="message-action-button"
        :class="{ 'is-copied': copied }"
        :disabled="!messageText"
        :aria-label="copied ? '已复制消息' : '复制消息'"
        :title="copied ? '已复制' : '复制消息'"
        @click="copyMessage"
      >
        <IconCheck v-if="copied" class="message-action-icon" stroke="2" aria-hidden="true" />
        <IconCopy v-else class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="message-action-button"
        aria-label="删除到此消息"
        title="删除到此消息"
        @click="openDeleteConfirm"
      >
        <IconTrash class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
    </div>
    <ConfirmPanel
      :open="confirmRetryOpen"
      title="重试消息？"
      :description-html="retryDescriptionHtml"
      :actions="retryConfirmActions"
      @action="onRetryConfirmAction"
    />
    <ConfirmPanel
      :open="confirmDeleteOpen"
      title="删除消息？"
      :description-html="deleteDescriptionHtml"
      :actions="deleteConfirmActions"
      @action="onDeleteConfirmAction"
    />
  </article>
</template>

<style scoped>
.message-floor {
  position: relative;
  width: 100%;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.15));
  padding: var(--space-4) var(--conversation-content-padding-right, calc(var(--space-4) + 24px))
    var(--space-4) var(--conversation-content-padding-left, var(--space-4));
  box-sizing: border-box;
  background-color: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
  transition: background-color var(--lc-message-bg-transition-duration) ease;
}

.message-floor.user {
  background-color: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}

.message-floor.model,
.message-floor.assistant {
  background-color: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
}

.message-floor.is-deleting {
  pointer-events: none;
  animation: lc-message-exit-right var(--lc-message-exit-duration) var(--lc-motion-exit-standard) forwards;
}

.message-floor.is-entering {
  animation: lc-message-enter var(--lc-message-enter-duration) var(--lc-motion-enter-emphasized) both;
}

.floor-container {
  max-width: 100%;
}

.floor-content-column {
  width: 100%;
  min-width: 0;
}

.floor-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  padding-right: 88px;
  flex-wrap: wrap;
}

.message-actions {
  position: absolute;
  top: var(--space-2);
  right: var(--conversation-content-padding-right, calc(var(--space-4) + 24px));
  display: flex;
  align-items: center;
  gap: var(--space-1);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--lc-message-actions-fade-duration) ease-out;
}

.message-floor:hover .message-actions {
  opacity: 1;
  pointer-events: auto;
}

.message-action-button {
  width: 26px;
  height: 26px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
}

.message-action-button:hover:not(:disabled),
.message-action-button:focus-visible {
  color: var(--vscode-foreground);
  background: transparent;
  border-color: transparent;
}

.message-action-button:focus-visible {
  outline: none;
}

.message-action-button:disabled {
  opacity: 0.45;
  border-color: transparent;
  cursor: default;
}

.message-action-icon {
  width: 15px;
  height: 15px;
  pointer-events: none;
}

.role-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.role-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: currentColor;
}

.role-chip.user {
  color: var(--vscode-testing-iconPassed, #4caf50);
}

.role-chip.assistant {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.floor-role-name {
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: currentColor;
}

.floor-status-badge {
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

.floor-status-badge.is-streaming {
  background-color: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.floor-status-badge.is-streaming::after {
  content: '';
  width: 6px;
  height: 6px;
  --lc-status-pulse-color: var(--vscode-testing-iconPassedColor, #4caf50);
  background-color: var(--vscode-testing-iconPassedColor, #4caf50);
  border-radius: 50%;
  display: inline-block;
  animation: lc-status-pulse-glow var(--lc-status-pulse-duration) infinite ease-in-out;
}

.floor-status-badge.is-stop {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  background-color: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.floor-status-badge.stop-paused {
  color: var(--vscode-testing-iconSkipped, var(--vscode-descriptionForeground));
}

.floor-status-badge.stop-cancelled {
  color: var(--vscode-errorForeground);
  border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
  background-color: var(--vscode-inputValidation-errorBackground, color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%));
}

.floor-status-badge.stop-replaced {
  color: var(--vscode-foreground);
  border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
}

.floor-status-badge.stop-stale {
  color: var(--vscode-descriptionForeground);
  border-style: dashed;
}

.floor-body {
  font-size: var(--font-size-md);
  line-height: 1.6;
  color: var(--vscode-foreground);
}
</style>
