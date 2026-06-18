<script setup lang="ts">
import AgentSettingsPanel from '@webview/components/settings/AgentSettingsPanel.vue';
</script>

<template>
  <div class="agent-settings-view">
    <header class="view-header">
      <span class="view-title">LimCode Agent 设置</span>
      <span class="view-hint">配置 Agent 角色层：人格 Prompt、能力上限与默认模型。</span>
    </header>
    <div class="view-body">
      <AgentSettingsPanel />
    </div>
  </div>
</template>

<style scoped>
.agent-settings-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.view-header { flex: 0 0 auto; display: flex; align-items: baseline; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
.view-title { font-weight: 600; }
.view-hint { color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.view-body { flex: 1; min-height: 0; overflow: hidden; padding: var(--space-4); }
</style>
