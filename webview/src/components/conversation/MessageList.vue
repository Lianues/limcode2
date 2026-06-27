<script setup lang="ts">
import { nextTick, onBeforeUnmount, watch } from 'vue';
import type { CheckpointRecord, CompressionBlockRecord, MessageRecord } from '@shared/protocol';
import { useConversationUiStore, type ConversationTimelineViewRow, type LlmErrorBlockRecord, type MessageViewRow } from '@webview/stores/useConversationUiStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { useChat } from '@webview/composables/useChat';
import { useRunHistoryStore } from '@webview/stores/useRunHistoryStore';
import { useCompression } from '@webview/composables/useCompression';
import CheckpointTimelineCard from './CheckpointTimelineCard.vue';
import { checkpointBeforeMessageFloor } from './checkpointRollback';
import CompressionTimelineCard from './CompressionTimelineCard.vue';
import MessageItem from './MessageItem.vue';
import VirtualTimelineList from './VirtualTimelineList.vue';

const props = withDefaults(
  defineProps<{
    emptyHint?: string;
    scroller?: HTMLElement | null;
  }>(),
  { emptyHint: '还没有消息，发一条试试。', scroller: null }
);

const ui = useConversationUiStore();
const timeline = useConversationTimelineStore();
const { retryMessageFrom, deleteMessagesFrom, cancelLlmAutoRetry } = useChat();
const { createCompression, deleteCompression, regenerateCompression, setCompressionEnabled } = useCompression();
const runHistory = useRunHistoryStore();

const AUTO_LOAD_TOP_THRESHOLD_PX = 480;
const AUTO_LOAD_UNDERFILLED_THRESHOLD_PX = 240;
let attachedScroller: HTMLElement | null = null;
let autoLoadFrame: number | undefined;

watch(() => props.scroller, attachScroller, { immediate: true, flush: 'post' });
watch(
  () => `${timeline.currentTimeline.status}:${timeline.currentHasOlder}:${ui.timelineRows.length}`,
  () => void nextTick(scheduleAutoLoadOlder),
  { flush: 'post' }
);

onBeforeUnmount(detachScroller);

function onDeleteFrom(message: MessageRecord): void {
  ui.playExitFrom(message.id, () => deleteMessagesFrom(message.conversationId, message.id));
}

function onEditMessage(row: MessageViewRow): void {
  ui.startEditMessage(row.message, row.deleteCount);
}

function onRetryFrom(message: MessageRecord): void {
  ui.playExitFrom(message.id, () => retryMessageFrom(message.conversationId, message.id));
}

function onCompactTo(message: MessageRecord): void {
  createCompression({ endMessageId: message.id });
}

function onCloseErrorBlock(id: string): void {
  ui.removeLlmErrorBlock(id);
}

function onCancelErrorRetry(block: LlmErrorBlockRecord): void {
  ui.markLlmRetryCancelPending(block.requestId);
  cancelLlmAutoRetry({ requestId: block.requestId, conversationId: block.conversationId, messageId: block.messageId, runId: block.runId });
}

function compactCountForMessage(message: MessageRecord): number {
  const floor = timeline.currentMessageFloorById[message.id];
  const messageCount = floor ?? timeline.currentMessages.filter((candidate) => candidate.seq <= message.seq).length;
  const previousCompressionCount = timeline.currentCompressionBlocks.filter((block) => {
    const anchorSeq = block.anchorSeq ?? block.endSeq;
    return anchorSeq !== undefined && anchorSeq < message.seq;
  }).length;
  return messageCount + previousCompressionCount;
}

function runIdForMessage(message: MessageRecord): string | undefined {
  if (message.role === 'user') return undefined;
  const links = timeline.currentTimeline.state.messageRunLinks;
  const link = links.find((candidate) => candidate.messageId === message.id && candidate.role === 'model')
    ?? links.find((candidate) => candidate.messageId === message.id);
  return link?.runId;
}

function isRunDetailLoading(message: MessageRecord): boolean {
  const runId = runIdForMessage(message);
  return !!runId && runHistory.activeDetail?.conversationId === message.conversationId && runHistory.activeDetail.runId === runId && runHistory.activeDetailState?.status === 'loadingDetail';
}

function onViewRunDetail(message: MessageRecord): void {
  const runId = runIdForMessage(message);
  runHistory.openDetail(message.conversationId, runId, message.id);
}

function onViewCompressionDetail(block: CompressionBlockRecord): void {
  runHistory.openCompressionDetail(block.conversationId, block.id);
}

function isEditingTarget(row: MessageViewRow): boolean {
  return ui.editingMessage?.message.id === row.message.id;
}

function rollbackCheckpointForMessage(message: MessageRecord): CheckpointRecord | undefined {
  return checkpointBeforeMessageFloor(timeline.currentCheckpoints, timeline.currentCheckpointTimelineAnchors, message.id);
}

function rowKey(row: ConversationTimelineViewRow): string {
  return row.id;
}

function attachScroller(element: HTMLElement | null | undefined): void {
  detachScroller();
  if (!element) return;
  attachedScroller = element;
  element.addEventListener('scroll', scheduleAutoLoadOlder, { passive: true });
  scheduleAutoLoadOlder();
}

function detachScroller(): void {
  if (attachedScroller) attachedScroller.removeEventListener('scroll', scheduleAutoLoadOlder);
  attachedScroller = null;
  if (autoLoadFrame !== undefined) window.cancelAnimationFrame(autoLoadFrame);
  autoLoadFrame = undefined;
}

function scheduleAutoLoadOlder(): void {
  if (autoLoadFrame !== undefined) return;
  autoLoadFrame = window.requestAnimationFrame(() => {
    autoLoadFrame = undefined;
    maybeLoadOlder();
  });
}

function maybeLoadOlder(): void {
  const scroller = attachedScroller;
  if (!scroller || !timeline.currentHasOlder) return;
  const status = timeline.currentTimeline.status;
  if (status === 'loadingInitial' || status === 'loadingOlder') return;
  const nearTop = scroller.scrollTop <= AUTO_LOAD_TOP_THRESHOLD_PX;
  const underfilled = scroller.scrollHeight <= scroller.clientHeight + AUTO_LOAD_UNDERFILLED_THRESHOLD_PX;
  if (nearTop || underfilled) timeline.requestOlder();
}
</script>

<template>
  <div class="message-list">
    <VirtualTimelineList :rows="ui.timelineRows" :scroller="props.scroller" :item-key="rowKey" :estimated-height="220">
      <template #default="{ row }">
      <MessageItem
        v-if="row.kind === 'message'"
        :message="row.message"
        :run-id="runIdForMessage(row.message)"
        :run-detail-loading="isRunDetailLoading(row.message)"
        :delete-count="row.deleteCount"
        :floor-number="row.messageFloorNumber"
        :deleting="row.phase === 'exiting'"
        :entering="row.phase === 'entering'"
        :editing-highlighted="isEditingTarget(row)"
        :rollback-checkpoint="rollbackCheckpointForMessage(row.message)"
        :compact-count="compactCountForMessage(row.message)"
        :error-blocks="ui.llmErrorBlocksForMessage(row.message.id)"
        @edit-message="onEditMessage(row)"
        @retry-from="onRetryFrom"
        @delete-from="onDeleteFrom"
        @compact-to="onCompactTo"
        @view-run-detail="onViewRunDetail"
        @close-error-block="onCloseErrorBlock"
        @cancel-error-retry="onCancelErrorRetry"
      />
      <CheckpointTimelineCard
        v-else-if="row.kind === 'checkpoint'"
        :checkpoint="row.checkpoint"
        :anchor="row.anchor"
        :phase="row.phase"
      />
      <CompressionTimelineCard
        v-else
        :block="row.block"
        :phase="row.phase"
        @delete="deleteCompression"
        @regenerate="regenerateCompression"
        @toggle-enabled="setCompressionEnabled"
        @view-detail="onViewCompressionDetail"
      />
      </template>
    </VirtualTimelineList>
    <div v-if="!ui.timelineRows.length" class="message-empty-container">
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
