<script setup lang="ts">
import { computed } from 'vue';
import { IconSettings } from '@tabler/icons-vue';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useChat } from '@webview/composables/useChat';

const props = defineProps<{
  settingsOpen: boolean;
}>();

const emit = defineEmits<{
  (event: 'toggle-settings'): void;
}>();

const clientState = useClientStateStore();
const { abortCurrentConversation } = useChat();

const title = computed(
  () => clientState.currentConversation?.title || clientState.currentConversationId || '正在初始化默认对话...'
);
const runSummary = computed(() => clientState.currentRunSummary);
const runStatusClass = computed(() => `run-status-${runSummary.value.status ?? 'idle'}`);

function onAbort(): void {
  abortCurrentConversation();
}
</script>

<template>
  <header class="tab-header">
    <div class="tab-header-main">
      <div class="tab-title-row">
        <span class="tab-title">{{ title }}</span>
        <span
          class="run-status"
          :class="[runStatusClass, { 'is-active': runSummary.isRunning }]"
          :title="runSummary.isRunning ? `后台任务：${runSummary.label}` : '当前无后台任务'"
        >
          <span class="run-status-dot" aria-hidden="true"></span>
          <span>{{ runSummary.isRunning ? runSummary.label : '空闲' }}</span>
        </span>
      </div>
    </div>
    <div class="tab-actions">
      <button
        v-if="runSummary.isRunning"
        type="button"
        class="tab-abort-button"
        title="手动终止当前对话的后台任务"
        @click="onAbort"
      >
        终止
      </button>
      <button
        type="button"
        class="tab-settings-toggle secondary"
        :aria-label="props.settingsOpen ? '收起对话设置' : '打开对话设置'"
        :aria-pressed="props.settingsOpen"
        :title="props.settingsOpen ? '收起对话设置' : '对话设置'"
        @click="emit('toggle-settings')"
      >
        <IconSettings class="tab-settings-icon" stroke="2" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.tab-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 0;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.tab-header-main {
  flex: 1 1 auto;
  min-width: 0;
}

.tab-title-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: nowrap;
}

.tab-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.run-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 20px;
  padding: 1px 7px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-sm);
  line-height: 1.4;
}

.run-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-descriptionForeground);
  opacity: 0.55;
}

.run-status.is-active {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.run-status.is-active .run-status-dot {
  background: var(--vscode-testing-iconQueued);
  opacity: 1;
  animation: lc-status-pulse-glow var(--lc-status-pulse-duration) infinite ease-in-out;
}

.run-status-paused .run-status-dot {
  background: var(--vscode-testing-iconSkipped);
  animation: none;
}

.run-status-waiting_tool .run-status-dot,
.run-status-waiting_child_run .run-status-dot {
  background: var(--vscode-testing-iconQueued);
}

.tab-actions {
  flex: 0 0 auto;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.tab-abort-button {
  flex: 0 0 auto;
}

.tab-settings-toggle {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border-color: transparent;
}

.tab-settings-toggle:hover:not(:disabled),
.tab-settings-toggle[aria-pressed='true'] {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.tab-settings-icon {
  width: 16px;
  height: 16px;
  color: currentColor;
  pointer-events: none;
}

.tab-abort-button {
  border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  color: var(--vscode-errorForeground);
  background: transparent;
  cursor: pointer;
}

.tab-abort-button:hover {
  background: var(--vscode-inputValidation-errorBackground, var(--vscode-list-hoverBackground));
}
</style>
