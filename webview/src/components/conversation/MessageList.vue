<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { isVisibleTextPart, type MessageRecord } from '@shared/protocol';
import { useDeferredExitAnimation } from '@webview/composables/useDeferredExitAnimation';
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

const { retryMessageFrom, deleteMessagesFrom } = useChat();
const DELETE_ANIMATION_MS = 180;
const MESSAGE_ENTER_MS = 260;
const messageExit = useDeferredExitAnimation({ durationMs: DELETE_ANIMATION_MS, clearDelayMs: 2000 });
const enteringMessageIds = ref<Set<string>>(new Set());
const seenMessageIds = new Set<string>();
const enterTimers = new Map<string, number>();
let initialized = false;

const deletingStartIndex = computed(() => {
  if (!messageExit.exitingFromId.value) return -1;
  return props.messages.findIndex((message) => message.id === messageExit.exitingFromId.value);
});

watch(
  () => props.messages.some((message) => message.id === messageExit.exitingFromId.value),
  (exists) => {
    if (messageExit.exitingFromId.value && !exists) messageExit.clear();
  }
);

watch(
  () => props.messages.map((message) => `${message.id}:${message.status}:${visibleTextLength(message)}`).join('\n'),
  () => syncEnteringMessages(),
  { immediate: true }
);

onBeforeUnmount(() => {
  for (const timer of enterTimers.values()) window.clearTimeout(timer);
  enterTimers.clear();
});

function syncEnteringMessages(): void {
  const currentIds = new Set(props.messages.map((message) => message.id));
  for (const id of [...enterTimers.keys()]) {
    if (!currentIds.has(id)) clearEntering(id);
  }

  if (!initialized) {
    for (const id of currentIds) seenMessageIds.add(id);
    initialized = true;
    return;
  }

  for (const id of currentIds) {
    if (!isReadyForEnterAnimation(id)) continue;
    if (seenMessageIds.has(id)) continue;
    seenMessageIds.add(id);
    markEntering(id);
  }
}

function markEntering(id: string): void {
  const next = new Set(enteringMessageIds.value);
  next.add(id);
  enteringMessageIds.value = next;
  enterTimers.set(id, window.setTimeout(() => clearEntering(id), MESSAGE_ENTER_MS));
}

function clearEntering(id: string): void {
  const timer = enterTimers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  enterTimers.delete(id);
  const next = new Set(enteringMessageIds.value);
  next.delete(id);
  enteringMessageIds.value = next;
}

function isDeleting(index: number): boolean {
  return deletingStartIndex.value >= 0 && index >= deletingStartIndex.value;
}

function isReadyForEnterAnimation(messageId: string): boolean {
  const message = props.messages.find((candidate) => candidate.id === messageId);
  if (!message) return false;
  if (message.role === 'user') return true;
  return message.status !== 'streaming' || visibleTextLength(message) > 0;
}

function visibleTextLength(message: MessageRecord): number {
  return message.content.parts.reduce((total, part) => total + (isVisibleTextPart(part) ? part.text.length : 0), 0);
}

function isEntering(messageId: string): boolean {
  return enteringMessageIds.value.has(messageId);
}

function playDeleteFrom(messageId: string, action: () => void, delay = DELETE_ANIMATION_MS): void {
  messageExit.playFrom(messageId, action, delay);
}

defineExpose({ playDeleteFrom });

function onDeleteFrom(message: MessageRecord): void {
  playDeleteFrom(message.id, () => deleteMessagesFrom(message.conversationId, message.id));
}

function onEditMessage(message: MessageRecord, index: number): void {
  emit('edit-message', { message, deleteCount: props.messages.length - index });
}

function onRetryFrom(message: MessageRecord): void {
  playDeleteFrom(message.id, () => retryMessageFrom(message.conversationId, message.id));
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
      :entering="isEntering(message.id)"
      @edit-message="onEditMessage(message, index)"
      @retry-from="onRetryFrom"
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
