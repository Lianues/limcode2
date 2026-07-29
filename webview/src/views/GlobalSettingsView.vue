<script setup lang="ts">
import { storeToRefs } from 'pinia';
import GlobalSettingsPanel from '@webview/components/settings/GlobalSettingsPanel.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';

const globalSettings = useGlobalSettingsStore();
const { hasExternalSettingsChange, externalChangedSectionLabels } = storeToRefs(globalSettings);
</script>

<template>
  <div class="global-settings-view">
    <header class="view-header">
      <span class="view-title">LimCode 全局设置</span>
      <span class="view-hint">渠道配置会作为后端默认 LLM 连接配置同步给全局设置订阅者。</span>
    </header>
    <div v-if="hasExternalSettingsChange" class="external-change-bar" role="status">
      <span class="external-change-text">
        其他窗口修改了设置（{{ externalChangedSectionLabels }}）。为避免覆盖你未保存的修改，暂未自动刷新。
      </span>
      <span class="external-change-actions">
        <button type="button" class="external-change-button is-primary" @click="globalSettings.applyExternalSettingsChange()">载入最新</button>
        <button type="button" class="external-change-button" @click="globalSettings.dismissExternalSettingsChange()">保留当前</button>
      </span>
    </div>
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

.external-change-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-editorWarning-foreground, #d7ba7d) 18%);
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
}

.external-change-text {
  min-width: 0;
}

.external-change-actions {
  display: flex;
  gap: var(--space-2);
}

.external-change-button {
  padding: 2px var(--space-2);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.external-change-button:hover {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
}

.external-change-button.is-primary {
  border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
  font-weight: 600;
}

.view-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: var(--space-4);
}
</style>
