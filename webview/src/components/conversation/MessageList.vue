<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { MessageRecord } from '@shared/protocol';
import { useChat } from '@webview/composables/useChat';
import MessageItem from './MessageItem.vue';

const props = withDefaults(
  defineProps<{
    messages: MessageRecord[];
    emptyHint?: string;
  }>(),
  { emptyHint: '还没有消息，发一条试试。' }
);

const emit = defineEmits<{
  (event: 'edit-message', payload: { message: MessageRecord; deleteCount: number }): void;
}>();

const { deleteMessagesFrom } = useChat();
const deletingFromId = ref<string>();
const deletingStartIndex = computed(() => {
  if (!deletingFromId.value) return -1;
  return props.messages.findIndex((message) => message.id === deletingFromId.value);
});

let deleteTimer: number | undefined;
let clearDeletingTimer: number | undefined;

onBeforeUnmount(() => {
  if (deleteTimer !== undefined) window.clearTimeout(deleteTimer);
  if (clearDeletingTimer !== undefined) window.clearTimeout(clearDeletingTimer);
});

watch(
  () => props.messages.some((message) => message.id === deletingFromId.value),
  (exists) => {
    if (deletingFromId.value && !exists) clearDeletingState();
  }
);

function isDeleting(index: number): boolean {
  return deletingStartIndex.value >= 0 && index >= deletingStartIndex.value;
}

function onDeleteFrom(message: MessageRecord): void {
  if (deleteTimer !== undefined) window.clearTimeout(deleteTimer);
  if (clearDeletingTimer !== undefined) window.clearTimeout(clearDeletingTimer);
  deletingFromId.value = message.id;
  deleteTimer = window.setTimeout(() => {
    deleteMessagesFrom(message.conversationId, message.id);
    deleteTimer = undefined;
    clearDeletingTimer = window.setTimeout(clearDeletingState, 2000);
  }, 180);
}

function clearDeletingState(): void {
  deletingFromId.value = undefined;
  if (clearDeletingTimer !== undefined) {
    window.clearTimeout(clearDeletingTimer);
    clearDeletingTimer = undefined;
  }
}

function onEditMessage(message: MessageRecord, index: number): void {
  emit('edit-message', { message, deleteCount: props.messages.length - index });
}
</script>

<template>
  <div class="message-list">
    <MessageItem
      v-for="(message, index) in messages"
      :key="message.id"
      :message="message"
      :delete-count="messages.length - index"
      :deleting="isDeleting(index)"
      @edit-message="onEditMessage(message, index)"
      @delete-from="onDeleteFrom"
    />
    <div v-if="!messages.length" class="message-empty-container">
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
