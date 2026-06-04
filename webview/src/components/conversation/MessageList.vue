<script setup lang="ts">
import type { MessageRecord } from '@shared/protocol';
import { useConversationUiStore, type MessageViewRow } from '@webview/stores/useConversationUiStore';
import { useChat } from '@webview/composables/useChat';
import MessageItem from './MessageItem.vue';

withDefaults(
  defineProps<{
    emptyHint?: string;
  }>(),
  { emptyHint: '还没有消息，发一条试试。' }
);

const ui = useConversationUiStore();
const { retryMessageFrom, deleteMessagesFrom } = useChat();

function onDeleteFrom(message: MessageRecord): void {
  ui.playExitFrom(message.id, () => deleteMessagesFrom(message.conversationId, message.id));
}

function onEditMessage(row: MessageViewRow): void {
  ui.startEditMessage(row.message, row.deleteCount);
}

function onRetryFrom(message: MessageRecord): void {
  ui.playExitFrom(message.id, () => retryMessageFrom(message.conversationId, message.id));
}

function isEditingTarget(row: MessageViewRow): boolean {
  return ui.editingMessage?.message.id === row.message.id;
}
</script>

<template>
  <div class="message-list">
    <MessageItem
      v-for="row in ui.messageRows"
      :key="row.id"
      :message="row.message"
      :delete-count="row.deleteCount"
      :deleting="row.phase === 'exiting'"
      :entering="row.phase === 'entering'"
      :editing-highlighted="isEditingTarget(row)"
      @edit-message="onEditMessage(row)"
      @retry-from="onRetryFrom"
      @delete-from="onDeleteFrom"
    />
    <div v-if="!ui.messageRows.length" class="message-empty-container">
      <p class="message-empty">{{ emptyHint }}</p>
    </div>
  </div>
</template>

<style scoped>
.message-list {
  position: relative;
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
