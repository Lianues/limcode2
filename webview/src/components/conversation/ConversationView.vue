<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { isVisibleTextPart } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useChat } from '@webview/composables/useChat';
import MessageList from './MessageList.vue';
import Composer from '@webview/components/input/Composer.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

const clientState = useClientStateStore();
const { currentMessages, currentConversationId } = storeToRefs(clientState);
const { sendMessage } = useChat();

const scroller = ref<HTMLElement | null>(null);

const ready = computed(() => !!currentConversationId.value);
const placeholder = computed(() =>
  ready.value ? '输入消息，Enter 发送，Shift+Enter 换行' : '默认对话初始化中...'
);
const emptyHint = computed(() => (ready.value ? '还没有消息，发一条试试。' : '默认对话初始化中，请稍候。'));

const scrollMarkers = computed(() =>
  currentMessages.value
    .filter((message) => message.role === 'user')
    .map((message, index) => {
      const text = message.content.parts
        .filter(isVisibleTextPart)
        .map((part) => part.text)
        .join('')
        .trim()
        .replace(/\s+/g, ' ');
      return {
        id: message.id,
        label: `用户消息 · ${index + 1}`,
        preview: text ? truncatePreview(text) : '',
        kind: 'user'
      };
    })
);

const messageMetrics = computed(() => ({
  count: currentMessages.value.length,
  visibleTextLength: currentMessages.value.reduce(
    (acc, message) =>
      acc + message.content.parts.reduce((sum, part) => sum + (isVisibleTextPart(part) ? part.text.length : 0), 0),
    0
  )
}));

function onSubmit(text: string): void {
  sendMessage(text);
}

function truncatePreview(text: string): string {
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function scrollToBottom(): void {
  void nextTick(() => {
    const element = scroller.value;
    if (element) element.scrollTop = element.scrollHeight;
  });
}

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 96;
}

// 只在消息新增/流式内容增长且用户接近底部时滚动到底部；删除/回退不触发滚动，避免列表抖动。
watch(
  messageMetrics,
  (next, previous) => {
    const grew = !previous || next.count > previous.count || next.visibleTextLength > previous.visibleTextLength;
    if (!grew) return;

    const element = scroller.value;
    if (!element || isNearBottom(element)) scrollToBottom();
  }
);
</script>

<template>
  <div class="conversation">
    <div class="conversation-body">
      <div ref="scroller" class="conversation-scroll">
        <MessageList :messages="currentMessages" :empty-hint="emptyHint" />
      </div>
      <AdvancedScrollbar
        :scroller="scroller"
        :markers="scrollMarkers"
        show-markers
        show-edge-buttons
        show-marker-preview
      />
    </div>
    <footer class="conversation-composer">
      <Composer :disabled="!ready" :placeholder="placeholder" @submit="onSubmit" />
    </footer>
  </div>
</template>

<style scoped>
.conversation {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  --conversation-content-padding-left: var(--space-4);
  --conversation-content-padding-right: calc(var(--space-4) + 24px);
}

.conversation-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.conversation-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 0;
  scrollbar-width: none;
}

.conversation-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.conversation-composer {
  border-top: 1px solid var(--vscode-panel-border);
  padding: var(--space-3) 0;
  background-color: var(--vscode-editor-background);
}
</style>
