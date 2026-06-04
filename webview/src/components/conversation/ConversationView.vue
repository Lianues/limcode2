<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { isVisibleTextPart, type MessageRecord } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useChat } from '@webview/composables/useChat';
import MessageList from './MessageList.vue';
import Composer from '@webview/components/input/Composer.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';

const clientState = useClientStateStore();
const { currentMessages, currentConversationId } = storeToRefs(clientState);
const { sendMessage, editMessage } = useChat();

const scroller = ref<HTMLElement | null>(null);
const messageList = ref<{
  playDeleteFrom: (messageId: string, action: () => void, delay?: number) => void;
} | null>(null);

interface EditingMessageState {
  message: MessageRecord;
  deleteCount: number;
  originalText: string;
}

const editingMessage = ref<EditingMessageState>();
const editKeySeed = ref(0);
const editConfirmOpen = ref(false);
const pendingEditText = ref('');

const ready = computed(() => !!currentConversationId.value);
const placeholder = computed(() =>
  ready.value ? '输入消息，Enter 发送，Shift+Enter 换行' : '默认对话初始化中...'
);
const emptyHint = computed(() => (ready.value ? '还没有消息，发一条试试。' : '默认对话初始化中，请稍候。'));
const editMode = computed(() => (editingMessage.value ? 'edit' : 'chat'));
const editKey = computed(() => editingMessage.value ? `${editingMessage.value.message.id}:${editKeySeed.value}` : '');
const editText = computed(() => editingMessage.value?.originalText ?? '');
const editFollowupCount = computed(() => Math.max(0, (editingMessage.value?.deleteCount ?? 1) - 1));
const editConfirmDescriptionHtml = computed(
  () => `是否编辑此消息？将同时删除后续 ${editFollowupCount.value} 条消息，此操作<strong>不可撤销</strong>`
);
const editConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'rollback-confirm', label: '回档并确认（占位，之后会做存档点功能）', variant: 'secondary' },
  { key: 'direct-confirm', label: '直接确认' }
];

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
  if (editingMessage.value) {
    pendingEditText.value = text;
    editConfirmOpen.value = true;
    return;
  }
  sendMessage(text);
}

function startEditMessage(payload: { message: MessageRecord; deleteCount: number }): void {
  editingMessage.value = {
    message: payload.message,
    deleteCount: payload.deleteCount,
    originalText: visibleMessageText(payload.message)
  };
  pendingEditText.value = '';
  editConfirmOpen.value = false;
  editKeySeed.value += 1;
}

function cancelEditMode(): void {
  editingMessage.value = undefined;
  pendingEditText.value = '';
  editConfirmOpen.value = false;
}

function handleEditConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') {
    editConfirmOpen.value = false;
    return;
  }

  if (action.key === 'rollback-confirm' || action.key === 'direct-confirm') {
    commitEditMessage();
  }
}

function commitEditMessage(): void {
  const editing = editingMessage.value;
  const text = pendingEditText.value.trim();
  if (!editing || !text) return;

  editConfirmOpen.value = false;

  const commit = (): void => {
    editMessage(editing.message.conversationId, editing.message.id, text, { runAfterEdit: true, deleteFollowing: true });
    cancelEditMode();
  };

  const nextMessage = nextMessageAfter(editing.message.id);
  if (nextMessage) {
    messageList.value?.playDeleteFrom(nextMessage.id, commit) ?? commit();
    return;
  }

  commit();
}

function nextMessageAfter(messageId: string): MessageRecord | undefined {
  const index = currentMessages.value.findIndex((message) => message.id === messageId);
  return index >= 0 ? currentMessages.value[index + 1] : undefined;
}

function visibleMessageText(message: MessageRecord): string {
  return message.content.parts
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join('')
    .trim();
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
        <MessageList ref="messageList" :messages="currentMessages" :empty-hint="emptyHint" @edit-message="startEditMessage" />
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
      <Composer
        :disabled="!ready"
        :placeholder="placeholder"
        :mode="editMode"
        :edit-key="editKey"
        :edit-text="editText"
        @submit="onSubmit"
        @cancel-edit="cancelEditMode"
      />
    </footer>
    <ConfirmPanel
      :open="editConfirmOpen"
      title="编辑消息"
      :description-html="editConfirmDescriptionHtml"
      :actions="editConfirmActions"
      @action="handleEditConfirmAction"
    />
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
