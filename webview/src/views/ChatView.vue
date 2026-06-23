<script setup lang="ts">
import TabHeader from '@webview/components/layout/TabHeader.vue';
import ConversationView from '@webview/components/conversation/ConversationView.vue';
import TaskListTopPanel from '@webview/components/taskList/TaskListTopPanel.vue';
</script>

<template>
  <div class="chat-view">
    <TabHeader />
    <TaskListTopPanel />
    <ConversationView />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
</style>
