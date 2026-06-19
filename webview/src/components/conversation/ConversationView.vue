<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { isVisibleTextPart, type MessageContent } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationUiStore } from '@webview/stores/useConversationUiStore';
import { useChat } from '@webview/composables/useChat';
import { useBottomStickyScroller } from '@webview/composables/useBottomStickyScroller';
import MessageList from './MessageList.vue';
import Composer from '@webview/components/input/Composer.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import RunHistoryDetailPanel from './RunHistoryDetailPanel.vue';

const clientState = useClientStateStore();
const conversationUi = useConversationUiStore();
const { currentMessages, currentCheckpoints, currentCheckpointTimelineAnchors, currentConversationId, currentConversationDetailLoaded } = storeToRefs(clientState);
const { sendMessage, editMessage } = useChat();

const scroller = ref<HTMLElement | null>(null);
const conversationBody = ref<HTMLElement | null>(null);

useBottomStickyScroller(scroller);

const loadingDetail = computed(() => !!currentConversationId.value && !currentConversationDetailLoaded.value);
const ready = computed(() => !!currentConversationId.value && currentConversationDetailLoaded.value);
const placeholder = computed(() =>
  ready.value
    ? '输入消息，Enter 发送，Shift+Enter 换行'
    : loadingDetail.value ? '对话内容加载中...' : '默认对话初始化中...'
);
const emptyHint = computed(() =>
  ready.value ? '还没有消息，发一条试试。' : loadingDetail.value ? '正在加载对话内容，请稍候。' : '默认对话初始化中，请稍候。'
);
const editFollowupCount = computed(() => Math.max(0, (conversationUi.editingMessage?.deleteCount ?? 1) - 1));
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
      const editing = conversationUi.editingMessage?.message.id === message.id;
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
        kind: editing ? 'user editing' : 'user'
      };
    })
);

watch(
  [currentMessages, currentCheckpoints, currentCheckpointTimelineAnchors],
  ([messages, checkpoints, checkpointAnchors]) => conversationUi.syncTimeline(messages, checkpoints, checkpointAnchors),
  { immediate: true }
);

function onSubmit(text: string, content?: MessageContent): void {
  if (conversationUi.isEditing) {
    conversationUi.pendingEditText = text;
    conversationUi.editConfirmOpen = true;
    return;
  }
  sendMessage(text, content);
}

function handleEditConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') {
    conversationUi.editConfirmOpen = false;
    return;
  }

  if (action.key === 'rollback-confirm' || action.key === 'direct-confirm') {
    commitEditMessage();
  }
}

function commitEditMessage(): void {
  const editing = conversationUi.editingMessage;
  const text = conversationUi.pendingEditText.trim();
  if (!editing || !text) return;

  conversationUi.editConfirmOpen = false;

  const commit = (): void => {
    editMessage(editing.message.conversationId, editing.message.id, text, { runAfterEdit: true, deleteFollowing: true });
    conversationUi.cancelEditMode();
  };

  const nextMessage = nextMessageAfter(editing.message.id);
  if (nextMessage) {
    conversationUi.playExitFrom(nextMessage.id, commit);
    return;
  }

  commit();
}

function nextMessageAfter(messageId: string) {
  const index = currentMessages.value.findIndex((message) => message.id === messageId);
  return index >= 0 ? currentMessages.value[index + 1] : undefined;
}

function truncatePreview(text: string): string {
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}
</script>

<template>
  <div class="conversation">
    <div ref="conversationBody" class="conversation-body">
      <div ref="scroller" class="conversation-scroll">
        <MessageList :empty-hint="emptyHint" />
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
      <Composer :disabled="!ready" :placeholder="placeholder" :expand-boundary="conversationBody" @submit="onSubmit" />
    </footer>
    <ConfirmPanel
      :open="conversationUi.editConfirmOpen"
      title="编辑消息"
      :description-html="editConfirmDescriptionHtml"
      :actions="editConfirmActions"
      @action="handleEditConfirmAction"
    />
    <RunHistoryDetailPanel />
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
  flex: 0 0 auto;
  border-top: 1px solid var(--vscode-panel-border);
  padding: var(--space-3) 0 0;
  background-color: var(--vscode-editor-background);
}
</style>
