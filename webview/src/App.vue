<script setup lang="ts">
import { useSessionStore } from '@webview/stores/useSessionStore';
import { useBridgeBootstrap } from '@webview/composables/useBridgeBootstrap';
import ChatView from '@webview/views/ChatView.vue';
import GlobalSettingsView from '@webview/views/GlobalSettingsView.vue';
import ModeSettingsView from '@webview/views/ModeSettingsView.vue';

// 在根组件挂载时接好桥接监听；视图按任务单元类型路由。
useBridgeBootstrap();
const session = useSessionStore();
</script>

<template>
  <GlobalSettingsView v-if="session.isGlobalSettings" />
  <ModeSettingsView v-else-if="session.isModeSettings" />
  <ChatView v-else />
</template>
