<script setup lang="ts">
import { computed } from 'vue';
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
const summary = computed(() => clientState.currentModelSummary);
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
      <span v-if="summary.modeName || summary.model" class="tab-meta">
        <template v-if="summary.modeName">模式：<code>{{ summary.modeName }}</code></template>
        <template v-if="summary.model"> · 模型：<code>{{ summary.model }}</code></template>
      </span>
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
      <button type="button" class="tab-settings-toggle secondary" @click="emit('toggle-settings')">
        {{ props.settingsOpen ? '收起对话设置' : '对话设置' }}
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
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.tab-header-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.tab-title-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.tab-title {
  font-weight: 600;
}

.tab-meta {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.run-status {
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
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.tab-settings-toggle,
.tab-abort-button {
  flex: 0 0 auto;
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
