<script setup lang="ts">
import WorkflowSettingsPanel from '@webview/components/settings/WorkflowSettingsPanel.vue';
</script>

<template>
  <div class="workflow-settings-view">
    <header class="view-header">
      <span class="view-title">LimCode 工作流编辑</span>
      <span class="view-hint">查看和编辑内置工作流、用户工作流的原始数据。</span>
    </header>
    <div class="view-body">
      <WorkflowSettingsPanel />
    </div>
  </div>
</template>

<style scoped>
.workflow-settings-view {
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
