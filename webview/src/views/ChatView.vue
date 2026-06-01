<script setup lang="ts">
import { ref } from 'vue';
import TabHeader from '@webview/components/layout/TabHeader.vue';
import ConversationView from '@webview/components/conversation/ConversationView.vue';
import ConversationSettingsPanel from '@webview/components/settings/ConversationSettingsPanel.vue';

const settingsOpen = ref(false);
</script>

<template>
  <div class="chat-view">
    <TabHeader :settings-open="settingsOpen" @toggle-settings="settingsOpen = !settingsOpen" />
    <section v-if="settingsOpen" class="chat-settings-drawer">
      <ConversationSettingsPanel />
    </section>
    <ConversationView />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
}

.chat-settings-drawer {
  border-bottom: 1px solid var(--vscode-panel-border);
  padding: var(--space-3) var(--space-4);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}
</style>
