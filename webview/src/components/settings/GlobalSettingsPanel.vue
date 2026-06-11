<script setup lang="ts">
import { computed, ref } from 'vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import {
  DEFAULT_GLOBAL_SETTINGS_TAB,
  GLOBAL_SETTINGS_TABS,
  type GlobalSettingsTabKey
} from './global/globalSettingsTabs';

const activeTab = ref<GlobalSettingsTabKey>(DEFAULT_GLOBAL_SETTINGS_TAB);
const contentScroller = ref<HTMLElement | null>(null);

const activeTabComponent = computed(() =>
  GLOBAL_SETTINGS_TABS.find((tab) => tab.key === activeTab.value)?.component ?? GLOBAL_SETTINGS_TABS[0]!.component
);
</script>

<template>
  <section class="settings-panel" aria-label="全局设置">
    <aside class="settings-tabs" aria-label="全局设置页签">
      <button
        v-for="tab in GLOBAL_SETTINGS_TABS"
        :key="tab.key"
        type="button"
        class="settings-tab"
        :class="{ 'is-active': activeTab === tab.key }"
        :aria-pressed="activeTab === tab.key"
        @click="activeTab = tab.key"
      >
        <component :is="tab.icon" class="tab-icon" stroke="2" aria-hidden="true" />
        <span class="tab-text">
          <span class="tab-label">{{ tab.label }}</span>
          <span class="tab-description">{{ tab.description }}</span>
        </span>
      </button>
    </aside>

    <div class="settings-content-shell">
      <div ref="contentScroller" class="settings-content">
        <component :is="activeTabComponent" />
      </div>

      <AdvancedScrollbar :scroller="contentScroller" :refresh-key="activeTab" show-edge-buttons />
    </div>
  </section>
</template>

<style scoped>
.settings-panel {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: 196px minmax(0, 1fr);
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
}

.settings-tabs {
  min-width: 0;
  padding: var(--space-2);
  border-right: 1px solid var(--vscode-panel-border);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.settings-tab {
  width: 100%;
  min-height: 56px;
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.settings-tab:hover:not(:disabled),
.settings-tab:focus-visible {
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.settings-tab.is-active {
  border-color: var(--vscode-panel-border);
  box-shadow: inset 3px 0 0 var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-foreground) 16%);
}

.tab-icon {
  width: 18px;
  height: 18px;
  color: var(--vscode-foreground);
}

.tab-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tab-label {
  font-weight: 600;
  line-height: 1.3;
}

.tab-description {
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-content-shell {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.settings-content {
  height: 100%;
  overflow-y: auto;
  padding: var(--space-4) calc(var(--space-4) + 28px) var(--space-4) var(--space-4);
  scrollbar-width: none;
}

.settings-content::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

@media (max-width: 720px) {
  .settings-panel {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .settings-tabs {
    border-right: 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-direction: row;
  }

  .settings-tab {
    min-height: 52px;
  }
}
</style>

<style src="./global/settingsTabContent.css"></style>
