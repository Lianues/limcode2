<script setup lang="ts">
import type { CheckpointRecord, MessageRecord } from '@shared/protocol';
import { useConversationUiStore, type MessageViewRow } from '@webview/stores/useConversationUiStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useChat } from '@webview/composables/useChat';
import { useRunHistoryStore } from '@webview/stores/useRunHistoryStore';
import { useCompression } from '@webview/composables/useCompression';
import CheckpointTimelineCard from './CheckpointTimelineCard.vue';
import { checkpointBeforeMessageFloor } from './checkpointRollback';
import CompressionTimelineCard from './CompressionTimelineCard.vue';
import MessageItem from './MessageItem.vue';

withDefaults(
  defineProps<{
    emptyHint?: string;
  }>(),
  { emptyHint: '还没有消息，发一条试试。' }
);

const ui = useConversationUiStore();
const clientState = useClientStateStore();
const { retryMessageFrom, deleteMessagesFrom } = useChat();
const { createCompression, deleteCompression, regenerateCompression, setCompressionEnabled } = useCompression();
const runHistory = useRunHistoryStore();

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
  const messageCount = clientState.currentMessages.filter((candidate) => candidate.seq <= message.seq).length;
  const previousCompressionCount = clientState.currentCompressionBlocks.filter((block) => {
    const anchorSeq = block.anchorSeq ?? block.endSeq;
    return anchorSeq !== undefined && anchorSeq < message.seq;
  }).length;
  return messageCount + previousCompressionCount;
}

function runIdForMessage(message: MessageRecord): string | undefined {
  if (message.role === 'user') return undefined;
  const link = clientState.messageRunLinks.find((candidate) => candidate.messageId === message.id && candidate.role === 'model')
    ?? clientState.messageRunLinks.find((candidate) => candidate.messageId === message.id);
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

function isEditingTarget(row: MessageViewRow): boolean {
  return ui.editingMessage?.message.id === row.message.id;
}

function rollbackCheckpointForMessage(message: MessageRecord): CheckpointRecord | undefined {
  return checkpointBeforeMessageFloor(clientState.currentCheckpoints, clientState.currentCheckpointTimelineAnchors, message.id);
}
</script>

<template>
  <div class="message-list">
    <template v-for="row in ui.timelineRows" :key="row.id">
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
      />
    </template>
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
