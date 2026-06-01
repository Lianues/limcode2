<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { isVisibleTextPart } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useChat } from '@webview/composables/useChat';
import MessageList from './MessageList.vue';
import Composer from '@webview/components/input/Composer.vue';

const clientState = useClientStateStore();
const { currentMessages, currentConversationId } = storeToRefs(clientState);
const { sendMessage } = useChat();

const scroller = ref<HTMLElement | null>(null);

const ready = computed(() => !!currentConversationId.value);
const placeholder = computed(() =>
  ready.value ? '输入消息，Enter 发送，Shift+Enter 换行' : '默认对话初始化中...'
);
const emptyHint = computed(() => (ready.value ? '还没有消息，发一条试试。' : '默认对话初始化中，请稍候。'));

function onSubmit(text: string): void {
  sendMessage(text);
}

function scrollToBottom(): void {
  void nextTick(() => {
    const element = scroller.value;
    if (element) element.scrollTop = element.scrollHeight;
  });
}

// 消息数量或可见文本长度变化（含流式增量）时滚动到底部。
watch(
  () =>
    currentMessages.value.reduce(
      (acc, message) =>
        acc + message.content.parts.reduce((sum, part) => sum + (isVisibleTextPart(part) ? part.text.length : 0), 0),
      currentMessages.value.length
    ),
  scrollToBottom
);
</script>

<template>
  <div class="conversation">
    <div ref="scroller" class="conversation-scroll">
      <MessageList :messages="currentMessages" :empty-hint="emptyHint" />
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
}

.conversation-scroll {
  flex: 1;
  overflow-y: auto;
  /* 楼层模式：边缘直接贴合，使分割线与背景色能延伸至左右两侧边界，更具现代一体感 */
  padding: 0;
}

.conversation-composer {
  border-top: 1px solid var(--vscode-panel-border);
  padding: var(--space-3) var(--space-4);
  background-color: var(--vscode-editor-background);
}
</style>
