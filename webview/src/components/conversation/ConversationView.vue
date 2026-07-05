<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import {
  TERMINAL_TOOL_CALL_STATUSES,
  isVisibleTextPart,
  type CheckpointRecord,
  type ClientState,
  type LlmInvocationRecord,
  type MessageContent,
  type MessageRecord
} from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { useConversationUiStore, type ActivityTimelineRowInput } from '@webview/stores/useConversationUiStore';
import { useChat } from '@webview/composables/useChat';
import { useBottomStickyScroller } from '@webview/composables/useBottomStickyScroller';
import { useCheckpointPolicyStore } from '@webview/stores/useCheckpointPolicyStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import MessageList from './MessageList.vue';
import Composer from '@webview/components/input/Composer.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import RunHistoryDetailPanel from './RunHistoryDetailPanel.vue';
import ConversationTimelineMarkers from './ConversationTimelineMarkers.vue';
import { checkpointBeforeMessageFloor, rollbackConfirmActionTitle } from './checkpointRollback';

const clientState = useClientStateStore();
const conversationTimeline = useConversationTimelineStore();
const conversationUi = useConversationUiStore();
const checkpointStore = useCheckpointPolicyStore();
const settings = useGlobalSettingsStore();
const { currentConversationId } = storeToRefs(clientState);
const { currentTimeline, currentMessages, currentAnchorMessages, currentCheckpoints, currentCheckpointTimelineAnchors, currentCompressionBlocks, currentMessageFloorById, currentTotalMessages } = storeToRefs(conversationTimeline);
const { sendMessage, editMessage, updateQueueInput } = useChat();

const scroller = ref<HTMLElement | null>(null);
const conversationBody = ref<HTMLElement | null>(null);
const autoDismissTimers = new Map<string, number>();
const bottomStickyScroller = useBottomStickyScroller(scroller);
let pendingInitialBottomConversationId = '';
let initialBottomScrollFrame: number | undefined;

const loadingDetail = computed(() => !!currentConversationId.value && currentTimeline.value.status === 'loadingInitial' && currentMessages.value.length === 0);
const ready = computed(() => !!currentConversationId.value && !loadingDetail.value);
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
const timelineActivityRows = computed<ActivityTimelineRowInput[]>(() =>
  buildPreparingActivityRows(currentTimeline.value.state, currentConversationId.value)
);
const editRollbackPending = ref(false);
const editRollbackCheckpoint = computed(() => {
  const editing = conversationUi.editingMessage;
  return editing ? checkpointBeforeMessageFloor(currentCheckpoints.value, currentCheckpointTimelineAnchors.value, editing.message.id) : undefined;
});
const editConfirmActions = computed<ConfirmPanelAction[]>(() => {
  const actions: ConfirmPanelAction[] = [
    { key: 'cancel', label: '取消', variant: 'secondary', disabled: editRollbackPending.value }
  ];
  if (editRollbackCheckpoint.value || editRollbackPending.value) {
    actions.push({
      key: 'rollback-confirm',
      label: editRollbackPending.value ? '正在回档...' : '回档并确认',
      variant: editRollbackPending.value || !editRollbackCheckpoint.value ? 'secondary' : 'default',
      disabled: editRollbackPending.value || !editRollbackCheckpoint.value,
      title: rollbackConfirmActionTitle(editRollbackCheckpoint.value)
    });
  }
  actions.push({ key: 'direct-confirm', label: '直接确认', disabled: editRollbackPending.value });
  return actions;
});

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
  [currentMessages, currentAnchorMessages, currentCheckpoints, currentCheckpointTimelineAnchors, currentCompressionBlocks, timelineActivityRows, currentMessageFloorById, currentTotalMessages],
  ([messages, anchorMessages, checkpoints, checkpointAnchors, compressionBlocks, activityRows, floorByMessageId, totalMessages]) => conversationUi.syncTimeline(messages, anchorMessages, checkpoints, checkpointAnchors, compressionBlocks, activityRows, floorByMessageId, totalMessages),
  { immediate: true }
);

// 初次进入/切换历史对话时，初始分页是最新 chunk；需要等数据落 DOM 后主动贴底，避免首帧停在顶部触发 older chunk 加载。
watch(
  () => currentConversationId.value,
  (conversationId) => {
    pendingInitialBottomConversationId = conversationId;
    bottomStickyScroller.scrollToBottomNow();
    scheduleInitialConversationBottomScroll();
  },
  { immediate: true, flush: 'post' }
);

watch(
  () => `${currentConversationId.value}:${currentTimeline.value.status}:${conversationUi.timelineRows.length}:${currentTimeline.value.loadedChunkIds.join('\u0001')}:${currentTimeline.value.pageInfo?.loadedAt ?? 0}`,
  () => scheduleInitialConversationBottomScroll(),
  { flush: 'post' }
);

watch(
  [
    currentCheckpoints,
    () => settings.loadedSections.checkpointMaintenance,
    () => settings.checkpointMaintenance.autoDismissEnabled,
    () => settings.checkpointMaintenance.autoDismissSeconds
  ],
  () => syncCheckpointAutoDismiss(),
  { immediate: true }
);

onBeforeUnmount(() => {
  clearCheckpointAutoDismissTimers();
  cancelInitialBottomScrollFrame();
});

function scheduleInitialConversationBottomScroll(): void {
  const conversationId = currentConversationId.value;
  if (!conversationId || pendingInitialBottomConversationId !== conversationId) return;

  const timeline = currentTimeline.value;
  const rowCount = conversationUi.timelineRows.length;
  const hasTimelinePage = timeline.loadedChunkIds.length > 0 || timeline.pageInfo !== undefined;
  if (timeline.status === 'loadingInitial' && rowCount === 0) return;
  if (!hasTimelinePage && rowCount === 0) return;

  void nextTick(() => {
    if (pendingInitialBottomConversationId !== conversationId || currentConversationId.value !== conversationId) return;

    bottomStickyScroller.scrollToBottomNow();
    cancelInitialBottomScrollFrame();
    initialBottomScrollFrame = window.requestAnimationFrame(() => {
      initialBottomScrollFrame = undefined;
      if (pendingInitialBottomConversationId !== conversationId || currentConversationId.value !== conversationId) return;

      bottomStickyScroller.scrollToBottomNow();
      pendingInitialBottomConversationId = '';
    });
  });
}

function cancelInitialBottomScrollFrame(): void {
  if (initialBottomScrollFrame === undefined) return;
  window.cancelAnimationFrame(initialBottomScrollFrame);
  initialBottomScrollFrame = undefined;
}

function onSubmit(text: string, content?: MessageContent): void {
  if (conversationUi.editingQueueRunId) {
    updateQueueInput(conversationUi.editingQueueRunId, text, content);
    conversationUi.cancelEditMode();
    return;
  }
  if (conversationUi.isEditing) {
    conversationUi.pendingEditText = text;
    conversationUi.editConfirmOpen = true;
    return;
  }
  sendMessage(text, content);
}

async function handleEditConfirmAction(action: ConfirmPanelAction): Promise<void> {
  if (action.key === 'cancel') {
    conversationUi.editConfirmOpen = false;
    return;
  }

  if (action.key === 'rollback-confirm') {
    if (!editRollbackCheckpoint.value || editRollbackPending.value) return;
    editRollbackPending.value = true;
    try {
      const checkpoint = editRollbackCheckpoint.value;
      const result = await checkpointStore.restoreCheckpoint(checkpoint);
      if (result.status !== 'restored') return;
      checkpointStore.dismissCheckpoint(checkpoint.id, checkpoint.conversationId);
    } finally {
      editRollbackPending.value = false;
    }
    commitEditMessage();
    return;
  }

  if (action.key === 'direct-confirm') {
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

function buildPreparingActivityRows(state: ClientState, conversationId: string): ActivityTimelineRowInput[] {
  if (!conversationId) return [];
  const rows = new Map<string, ActivityTimelineRowInput>();

  for (const message of state.messages) {
    if (message.conversationId !== conversationId || !isPreStartEmptyModelMessage(message, state)) continue;
    const runId = runIdForModelMessage(message.id, state);
    const key = runId ?? message.id;
    rows.set(key, {
      id: message.id,
      conversationId,
      ...(runId ? { runId } : {}),
      hiddenMessageId: message.id,
      activityKind: 'preparing'
    });
  }

  const runIds = new Set(state.agentRunTargetLinks
    .filter((link) => link.conversationId === conversationId)
    .map((link) => link.runId));
  const activeRuns = state.agentRuns
    .filter((run) => runIds.has(run.id))
    .filter((run) => run.status === 'preparing' || run.status === 'running')
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

  for (const run of activeRuns) {
    if (rows.has(run.id)) continue;
    if (hasActiveToolWork(run.id, state)) continue;
    if (hasVisibleStreamingModelMessage(run.id, state)) continue;
    rows.set(run.id, {
      id: `activity:preparing:${run.id}`,
      conversationId,
      runId: run.id,
      activityKind: 'preparing'
    });
  }

  return [...rows.values()];
}

function hasActiveToolWork(runId: string, state: ClientState): boolean {
  const toolCallIds = new Set(state.toolCallRunLinks
    .filter((link) => link.runId === runId)
    .map((link) => link.toolCallId));
  return state.toolCalls.some((call) => toolCallIds.has(call.id) && !TERMINAL_TOOL_CALL_STATUSES.has(call.status));
}

function hasVisibleStreamingModelMessage(runId: string, state: ClientState): boolean {
  const messageIds = new Set(state.messageRunLinks
    .filter((link) => link.runId === runId && link.role === 'model')
    .map((link) => link.messageId));
  return state.messages.some((message) => messageIds.has(message.id) && message.status === 'streaming' && !isPreStartEmptyModelMessage(message, state));
}

function runIdForModelMessage(messageId: string, state: ClientState): string | undefined {
  return state.messageRunLinks.find((link) => link.messageId === messageId && link.role === 'model')?.runId
    ?? state.messageRunLinks.find((link) => link.messageId === messageId)?.runId;
}

function isPreStartEmptyModelMessage(message: MessageRecord, state: ClientState): boolean {
  if (message.role !== 'model' || message.status !== 'streaming' || message.content.parts.length > 0) return false;
  const invocation = invocationForMessage(message.id, state);
  return !!invocation && invocation.status !== 'streaming';
}

function invocationForMessage(messageId: string, state: ClientState): LlmInvocationRecord | undefined {
  const link = state.messageLlmInvocationLinks.find((candidate) => candidate.messageId === messageId);
  if (!link) return undefined;
  return state.llmInvocations.find((invocation) => invocation.id === link.invocationId);
}

function syncCheckpointAutoDismiss(): void {
  settings.ensureCheckpointMaintenance();
  if (!settings.loadedSections.checkpointMaintenance || !settings.checkpointMaintenance.autoDismissEnabled) {
    clearCheckpointAutoDismissTimers();
    return;
  }

  const eligibleCheckpoints = new Map(
    currentCheckpoints.value
      .filter(checkpointShouldAutoDismiss)
      .map((checkpoint) => [checkpoint.id, checkpoint])
  );

  for (const id of [...autoDismissTimers.keys()]) {
    if (eligibleCheckpoints.has(id)) continue;
    clearCheckpointAutoDismissTimer(id);
  }

  const delayMs = Math.max(1, Math.floor(settings.checkpointMaintenance.autoDismissSeconds || 5)) * 1000;
  for (const checkpoint of eligibleCheckpoints.values()) {
    if (autoDismissTimers.has(checkpoint.id)) continue;
    const timer = window.setTimeout(() => {
      autoDismissTimers.delete(checkpoint.id);
      checkpointStore.dismissCheckpoint(checkpoint.id, checkpoint.conversationId);
    }, delayMs);
    autoDismissTimers.set(checkpoint.id, timer);
  }
}

function checkpointShouldAutoDismiss(checkpoint: CheckpointRecord): boolean {
  return checkpoint.status === 'failed' || (checkpoint.status === 'skipped' && checkpoint.skipReason !== 'no_changes');
}

function clearCheckpointAutoDismissTimer(id: string): void {
  const timer = autoDismissTimers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  autoDismissTimers.delete(id);
}

function clearCheckpointAutoDismissTimers(): void {
  for (const id of [...autoDismissTimers.keys()]) clearCheckpointAutoDismissTimer(id);
}
</script>

<template>
  <div class="conversation">
    <div ref="conversationBody" class="conversation-body">
      <div ref="scroller" class="conversation-scroll">
        <MessageList :empty-hint="emptyHint" :scroller="scroller" />
      </div>
      <ConversationTimelineMarkers
        :markers="conversationUi.checkpointMarkers"
        :scroller="scroller"
        @toggle="conversationUi.toggleCheckpointMarker"
      />
      <AdvancedScrollbar
        class="conversation-main-scrollbar"
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
      @cancel="conversationUi.editConfirmOpen = false"
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
  --conversation-timeline-marker-width: 24px;
  --conversation-content-padding-left: var(--conversation-timeline-marker-width);
  --conversation-content-padding-right: var(--conversation-timeline-marker-width);
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

.conversation :deep(.advanced-scrollbar.conversation-main-scrollbar) {
  right: 0;
}

.conversation-composer {
  flex: 0 0 auto;
  border-top: 1px solid var(--vscode-panel-border);
  padding: 0;
  background-color: var(--vscode-editor-background);
}
</style>
