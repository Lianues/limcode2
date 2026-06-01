<script setup lang="ts">
import GlobalSettingsPanel from '@webview/components/settings/GlobalSettingsPanel.vue';
</script>

<template>
  <div class="global-settings-view">
    <header class="view-header">
      <span class="view-title">LimCode 全局设置</span>
      <span class="view-hint">LLM 设置属于全局配置，会同步给全局设置订阅者。</span>
    </header>
    <div class="view-body">
      <GlobalSettingsPanel />
    </div>
  </div>
</template>

<style scoped>
.global-settings-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
}

.view-header {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-wrap: wrap;
}

.view-title {
  font-weight: 600;
}

.view-hint {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.view-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
}
</style>
