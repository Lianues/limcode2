<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, watch } from 'vue';
import type { CheckpointRecord, CompressionBlockRecord, MessageRecord } from '@shared/protocol';
import { useConversationUiStore, type ConversationTimelineViewRow, type LlmErrorBlockRecord, type MessageViewRow } from '@webview/stores/useConversationUiStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { useChat } from '@webview/composables/useChat';
import { useRunHistoryStore } from '@webview/stores/useRunHistoryStore';
import { useCompression } from '@webview/composables/useCompression';
import { checkpointBeforeMessageFloor } from './checkpointRollback';
import CompressionTimelineCard from './CompressionTimelineCard.vue';
import MessageItem from './MessageItem.vue';
import TimelineActivityRow from './TimelineActivityRow.vue';

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
const AUTO_LOAD_BOTTOM_GUARD_PX = 16;
const AUTO_LOAD_UNDERFILLED_THRESHOLD_PX = 240;
let attachedScroller: HTMLElement | null = null;
let autoLoadFrame: number | undefined;
let pendingTimelineAnchor: TimelineRowAnchor | undefined;

interface TimelineRowAnchor {
  key: string;
  top: number;
}

watch(() => props.scroller, attachScroller, { immediate: true, flush: 'post' });
watch(
  () => `${timeline.currentTimeline.status}:${timeline.currentHasOlder}:${timeline.currentTimeline.loadedChunkIds.join('\u0001')}:${ui.timelineRows.length}`,
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

const rowKeySignature = computed(() => ui.timelineRows.map(rowKey).join('\u0001'));
const isLoadingOlder = computed(() => timeline.currentTimeline.status === 'loadingOlder');

watch(rowKeySignature, () => {
  pendingTimelineAnchor = captureTimelineAnchor();
  if (!pendingTimelineAnchor) return;
  void nextTick(restoreTimelineAnchor);
}, { flush: 'pre' });

function captureTimelineAnchor(): TimelineRowAnchor | undefined {
  const scroller = props.scroller;
  if (!scroller) return undefined;

  const scrollerTop = scroller.getBoundingClientRect().top;
  const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-timeline-row-key]'));
  const anchorElement = rows.find((element) => element.getBoundingClientRect().bottom > scrollerTop + 1);
  const key = anchorElement?.dataset.timelineRowKey;
  if (!anchorElement || !key) return undefined;

  return { key, top: anchorElement.getBoundingClientRect().top };
}

function restoreTimelineAnchor(): void {
  const anchor = pendingTimelineAnchor;
  pendingTimelineAnchor = undefined;
  const scroller = props.scroller;
  if (!anchor || !scroller) return;

  const anchorElement = Array.from(scroller.querySelectorAll<HTMLElement>('[data-timeline-row-key]')).find(
    (element) => element.dataset.timelineRowKey === anchor.key
  );
  if (!anchorElement) return;

  const delta = anchorElement.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) <= 0.5) return;
  scroller.scrollTop += delta;
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
  if (!scroller) return;
  const current = timeline.currentTimeline;
  const status = current.status;
  const hasLoadedPage = current.loadedChunkIds.length > 0 && current.pageInfo !== undefined;
  if (status === 'loadingOlder' || (status === 'loadingInitial' && !hasLoadedPage)) return;

  if (!hasLoadedPage) {
    timeline.requestInitial(timeline.currentConversationId);
    return;
  }

  if (!timeline.currentHasOlder) return;
  const distanceFromBottom = Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
  const nearTop = scroller.scrollTop <= AUTO_LOAD_TOP_THRESHOLD_PX && distanceFromBottom > AUTO_LOAD_BOTTOM_GUARD_PX;
  const underfilled = scroller.scrollHeight <= scroller.clientHeight + AUTO_LOAD_UNDERFILLED_THRESHOLD_PX;
  if (nearTop || underfilled) {
    timeline.requestOlder();
  }
}
</script>

<template>
  <div class="message-list">
    <div v-if="isLoadingOlder" class="message-list-loading-layer" role="status" aria-live="polite">
      <div class="message-list-loading-pill">
        <span class="message-list-loading-spinner" aria-hidden="true"></span>
        <span>正在加载更早消息…</span>
      </div>
    </div>
    <div
      v-for="row in ui.timelineRows"
      :key="rowKey(row)"
      class="message-list-row"
      :data-timeline-row-key="rowKey(row)"
    >
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
      <CompressionTimelineCard
        v-else-if="row.kind === 'compression'"
        :block="row.block"
        :phase="row.phase"
        @delete="deleteCompression"
        @regenerate="regenerateCompression"
        @toggle-enabled="setCompressionEnabled"
        @view-detail="onViewCompressionDetail"
      />
      <TimelineActivityRow
        v-else-if="row.kind === 'activity'"
        :activity-kind="row.activityKind"
      />
    </div>
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
  overflow-anchor: none;
}

.message-list-row {
  display: block;
}

.message-list-loading-layer {
  position: sticky;
  top: 8px;
  z-index: 6;
  height: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
}

.message-list-loading-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 10px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.message-list-loading-spinner {
  width: 10px;
  height: 10px;
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
  border-top-color: color-mix(in srgb, var(--vscode-foreground) 68%, transparent);
  border-radius: 50%;
  animation: message-list-loading-spin 0.8s linear infinite;
}

@keyframes message-list-loading-spin {
  to {
    transform: rotate(360deg);
  }
}

.message-empty-container {
  padding: var(--space-6) var(--conversation-content-padding-right, var(--space-4))
    var(--space-6) var(--conversation-content-padding-left, var(--space-4));
}

.message-empty {
  margin: var(--space-6) 0 0;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}
</style>
