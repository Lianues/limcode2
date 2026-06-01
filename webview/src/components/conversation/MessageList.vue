<script setup lang="ts">
import type { MessageRecord } from '@shared/protocol';
import MessageItem from './MessageItem.vue';

withDefaults(
  defineProps<{
    messages: MessageRecord[];
    emptyHint?: string;
  }>(),
  { emptyHint: '还没有消息，发一条试试。' }
);
</script>

<template>
  <div class="message-list">
    <MessageItem v-for="message in messages" :key="message.id" :message="message" />
    <p v-if="!messages.length" class="message-empty">{{ emptyHint }}</p>
  </div>
</template>

<style scoped>
.message-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.message-empty {
  margin: var(--space-6) 0 0;
  text-align: center;
  color: var(--vscode-descriptionForeground);
}
</style>
