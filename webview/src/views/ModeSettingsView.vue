<script setup lang="ts">
import ModeSettingsPanel from '@webview/components/settings/ModeSettingsPanel.vue';
</script>

<template>
  <div class="mode-settings-view">
    <header class="view-header">
      <span class="view-title">LimCode 工作流设置</span>
      <span class="view-hint">配置内置工作流、用户工作流，以及工作流级工具策略。</span>
    </header>
    <div class="view-body">
      <ModeSettingsPanel />
    </div>
  </div>
</template>

<style scoped>
.mode-settings-view {
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
