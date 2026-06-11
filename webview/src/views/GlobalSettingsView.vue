<script setup lang="ts">
import GlobalSettingsPanel from '@webview/components/settings/GlobalSettingsPanel.vue';
</script>

<template>
  <div class="global-settings-view">
    <header class="view-header">
      <span class="view-title">LimCode 全局设置</span>
      <span class="view-hint">渠道配置会作为后端默认 LLM 连接配置同步给全局设置订阅者。</span>
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
  height: 100%;
  min-height: 0;
}

.view-header {
  flex: 0 0 auto;
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
  min-height: 0;
  overflow: hidden;
  padding: var(--space-4);
}
</style>
