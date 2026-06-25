<script setup lang="ts">
import { computed } from 'vue';
import type { CheckpointRecord, CompressionBlockRecord, MessageRecord } from '@shared/protocol';
import { useConversationUiStore, type ConversationTimelineViewRow, type MessageViewRow } from '@webview/stores/useConversationUiStore';
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
const { retryMessageFrom, deleteMessagesFrom } = useChat();
const { createCompression, deleteCompression, regenerateCompression, setCompressionEnabled } = useCompression();
const runHistory = useRunHistoryStore();

const timelineStatusLabel = computed(() => {
  const info = timeline.currentTimeline.pageInfo;
  const loaded = timeline.currentLoadedMessageCount;
  const total = timeline.currentTotalMessages || info?.totalMessages || loaded;
  return total > 0 ? `已加载 ${loaded}/${total} 条消息` : '';
});
const loadingOlder = computed(() => timeline.currentTimeline.status === 'loadingOlder');

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

function loadOlder(): void {
  timeline.requestOlder();
}

function rowKey(row: ConversationTimelineViewRow): string {
  return row.id;
}
</script>

<template>
  <div class="message-list">
    <div v-if="timeline.currentHasOlder || timelineStatusLabel" class="timeline-load-more">
      <button
        v-if="timeline.currentHasOlder"
        type="button"
        class="timeline-load-more-button"
        :disabled="loadingOlder"
        @click="loadOlder"
      >
        {{ loadingOlder ? '正在加载更早消息…' : '加载更早消息' }}
      </button>
      <span v-else class="timeline-load-more-done">已到达对话开始</span>
      <span v-if="timelineStatusLabel" class="timeline-load-more-count">{{ timelineStatusLabel }}</span>
    </div>
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
        @edit-message="onEditMessage(row)"
        @retry-from="onRetryFrom"
        @delete-from="onDeleteFrom"
        @compact-to="onCompactTo"
        @view-run-detail="onViewRunDetail"
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

.timeline-load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 34px;
  padding: var(--space-2) var(--conversation-content-padding-right, calc(var(--space-4) + 24px)) var(--space-2) var(--conversation-content-padding-left, var(--space-4));
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.timeline-load-more-button {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 3px 10px;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
  font: inherit;
  cursor: pointer;
}

.timeline-load-more-button:hover:not(:disabled),
.timeline-load-more-button:focus-visible {
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.timeline-load-more-button:disabled {
  cursor: progress;
  opacity: 0.7;
}

.timeline-load-more-done,
.timeline-load-more-count {
  color: var(--vscode-descriptionForeground);
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
