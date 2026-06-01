<script setup lang="ts">
import { computed } from 'vue';
import { useClientStateStore } from '@webview/stores/useClientStateStore';

defineProps<{
  settingsOpen: boolean;
}>();

const emit = defineEmits<{
  (event: 'toggle-settings'): void;
}>();

const clientState = useClientStateStore();

const title = computed(
  () => clientState.currentConversation?.title || clientState.currentConversationId || '正在初始化默认对话...'
);
const summary = computed(() => clientState.currentModelSummary);
</script>

<template>
  <header class="tab-header">
    <div class="tab-header-main">
      <span class="tab-title">{{ title }}</span>
      <span v-if="summary.modeName || summary.model" class="tab-meta">
        <template v-if="summary.modeName">模式：<code>{{ summary.modeName }}</code></template>
        <template v-if="summary.model"> · 模型：<code>{{ summary.model }}</code></template>
      </span>
    </div>
    <button type="button" class="tab-settings-toggle secondary" @click="emit('toggle-settings')">
      {{ settingsOpen ? '收起对话设置' : '对话设置' }}
    </button>
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
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.tab-title {
  font-weight: 600;
}

.tab-meta {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.tab-settings-toggle {
  flex: 0 0 auto;
}
</style>
