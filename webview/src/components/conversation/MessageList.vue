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
    <MessageItem
      v-for="(message, index) in messages"
      :key="message.id"
      :message="message"
      :delete-count="messages.length - index"
    />
    <div v-if="!messages.length" class="message-empty-container">
      <p class="message-empty">{{ emptyHint }}</p>
    </div>
  </div>
</template>

<style scoped>
.message-list {
  display: flex;
  flex-direction: column;
  gap: 0; /* 楼层之间无缝级联拼接 */
}

.message-empty-container {
  padding: var(--space-6) var(--space-4);
}

.message-empty {
  margin: var(--space-6) 0 0;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}
</style>
