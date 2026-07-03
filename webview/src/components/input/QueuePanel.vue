<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconBolt, IconClock, IconGripVertical, IconPencil, IconPlayerPause, IconPlayerPlay, IconTrash } from '@tabler/icons-vue';
import { isVisibleTextPart, type AgentRunQueueHoldReason } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import CollapsibleContentBlock from '@webview/components/content/CollapsibleContentBlock.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

export interface QueueItem {
  runId: string;
  queuedInputId: string;
  text: string;
  order: number;
  createdAt: number;
  holdReason?: AgentRunQueueHoldReason;
}

const emit = defineEmits<{
  (event: 'edit', item: QueueItem): void;
  (event: 'delete', runId: string): void;
  (event: 'force-send', runId: string): void;
  (event: 'reorder', runIds: string[]): void;
  (event: 'pause', runId: string): void;
  (event: 'resume', runId: string): void;
  (event: 'resume-all'): void;
}>();

const clientState = useClientStateStore();
const scroller = ref<HTMLElement | null>(null);
const draggingRunId = ref<string | undefined>();
const dragOverRunId = ref<string | undefined>();
const dragInsertAfter = ref(false);
const localOrderRunIds = ref<string[]>([]);
const expanded = ref(true);

const queueItems = computed<QueueItem[]>(() => {
  const conversationId = clientState.currentConversationId;
  if (!conversationId) return [];

  const runIds = new Set(
    clientState.agentRunTargetLinks
      .filter((link) => link.conversationId === conversationId)
      .map((link) => link.runId)
  );
  if (runIds.size === 0) return [];

  const queuedRuns = clientState.agentRuns
    .filter((run) => runIds.has(run.id) && run.status === 'queued')
    .map((run) => {
      const order = clientState.agentRunQueueOrders.find((candidate) => candidate.runId === run.id && candidate.conversationId === conversationId);
      return { run, order: order?.order ?? run.createdAt };
    })
    .sort((left, right) => left.order - right.order || left.run.createdAt - right.run.createdAt || left.run.id.localeCompare(right.run.id));

  if (queuedRuns.length === 0) return [];

  const items = queuedRuns.map(({ run, order }) => {
    const queuedInput = clientState.agentRunQueuedInputs.find((candidate) => candidate.runId === run.id && candidate.conversationId === conversationId);
    const hold = clientState.agentRunQueueHolds.find((candidate) => candidate.runId === run.id && candidate.conversationId === conversationId);
    const text = queuedInput
      ? queuedInput.content.parts.filter(isVisibleTextPart).map((part) => part.text).join('').trim()
      : '';
    return { runId: run.id, queuedInputId: queuedInput?.id ?? '', text, order, createdAt: run.createdAt, ...(hold ? { holdReason: hold.reason } : {}) };
  });

  return items;
});

const displayQueueItems = computed<QueueItem[]>(() => {
  const items = queueItems.value;
  if (localOrderRunIds.value.length === 0) return items;

  const itemByRunId = new Map(items.map((item) => [item.runId, item]));
  const ordered: QueueItem[] = [];
  for (const runId of localOrderRunIds.value) {
    const item = itemByRunId.get(runId);
    if (item) ordered.push(item);
  }
  for (const item of items) {
    if (!localOrderRunIds.value.includes(item.runId)) ordered.push(item);
  }
  return ordered;
});

const heldQueueItems = computed(() => queueItems.value.filter((item) => !!item.holdReason));
const hasRestoredHold = computed(() => heldQueueItems.value.some((item) => item.holdReason === 'restored'));
const queueSummaryText = computed(() => {
  const total = queueItems.value.length;
  const held = heldQueueItems.value.length;
  if (held > 0) return `${total} 条 · ${hasRestoredHold.value ? '已恢复待继续' : `已暂停 ${held} 条`}`;
  return `${total} 条`;
});

function queueHoldLabel(reason: AgentRunQueueHoldReason | undefined): string {
  if (reason === 'restored') return '已恢复，待继续';
  if (reason === 'manual') return '已暂停';
  return '排队中';
}

function onDragStart(event: DragEvent, item: QueueItem): void {
  if (displayQueueItems.value.length <= 1) return;
  draggingRunId.value = item.runId;
  localOrderRunIds.value = displayQueueItems.value.map((candidate) => candidate.runId);
  event.dataTransfer?.setData('text/plain', item.runId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onDragOver(event: DragEvent, item: QueueItem): void {
  if (!draggingRunId.value || draggingRunId.value === item.runId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const element = event.currentTarget as HTMLElement | null;
  const rect = element?.getBoundingClientRect();
  const insertAfter = rect ? event.clientY > rect.top + rect.height / 2 : false;
  moveDraggingItem(item.runId, insertAfter);
}

function onDrop(event: DragEvent): void {
  if (!draggingRunId.value) return;
  event.preventDefault();
  const nextOrder = localOrderRunIds.value.length > 0 ? [...localOrderRunIds.value] : displayQueueItems.value.map((item) => item.runId);
  clearDragState();
  emit('reorder', nextOrder);
}

function onDragEnd(): void {
  clearDragState();
}

function moveDraggingItem(targetRunId: string, insertAfter: boolean): void {
  const dragging = draggingRunId.value;
  if (!dragging) return;
  const current = localOrderRunIds.value.length > 0 ? [...localOrderRunIds.value] : displayQueueItems.value.map((item) => item.runId);
  const withoutDragging = current.filter((runId) => runId !== dragging);
  const targetIndex = withoutDragging.indexOf(targetRunId);
  if (targetIndex < 0) return;
  withoutDragging.splice(targetIndex + (insertAfter ? 1 : 0), 0, dragging);

  const next = withoutDragging;
  if (next.join('\n') !== current.join('\n')) localOrderRunIds.value = next;
  dragOverRunId.value = targetRunId;
  dragInsertAfter.value = insertAfter;
}

function clearDragState(): void {
  draggingRunId.value = undefined;
  dragOverRunId.value = undefined;
  dragInsertAfter.value = false;
  localOrderRunIds.value = [];
}
</script>

<template>
  <div v-if="queueItems.length > 0" class="queue-panel">
    <CollapsibleContentBlock
      v-model:expanded="expanded"
      class="queue-panel-collapsible"
      aria-label="展开或收起消息队列"
      kind="input"
      :icon-active="heldQueueItems.length > 0"
    >
      <template #icon>
        <IconClock stroke="2" aria-hidden="true" />
      </template>
      <template #summary>
        <span class="queue-panel-title">消息队列</span>
        <span class="queue-panel-summary">{{ queueSummaryText }}</span>
      </template>
      <template v-if="heldQueueItems.length > 0" #actions>
        <button type="button" class="queue-hold-banner-action" aria-label="全部继续排队" @click="emit('resume-all')">全部继续</button>
      </template>

      <div ref="scroller" class="queue-panel-scroll">
      <div
        v-for="(item, index) in displayQueueItems"
        :key="item.runId"
        class="queue-item"
        :class="{
          'is-held': !!item.holdReason,
          'is-dragging': draggingRunId === item.runId,
          'is-drag-over-before': dragOverRunId === item.runId && !dragInsertAfter,
          'is-drag-over-after': dragOverRunId === item.runId && dragInsertAfter
        }"
        :draggable="displayQueueItems.length > 1"
        @dragstart="onDragStart($event, item)"
        @dragover="onDragOver($event, item)"
        @drop="onDrop"
        @dragend="onDragEnd"
      >
        <span class="queue-drag-handle" aria-label="拖拽调整排队顺序">
          <IconGripVertical :size="14" stroke="2" />
        </span>
        <span class="queue-item-icon" aria-hidden="true">
          <IconClock :size="14" stroke="2" />
        </span>
        <span class="queue-item-index">{{ index + 1 }}</span>
        <span class="queue-item-status" :class="{ 'is-held': !!item.holdReason }">{{ queueHoldLabel(item.holdReason) }}</span>
        <span class="queue-item-text">{{ item.text || '(空消息)' }}</span>
        <div class="queue-item-actions">
          <button type="button" class="queue-item-action" aria-label="编辑排队消息" :disabled="!item.queuedInputId" draggable="false" @click="emit('edit', item)">
            <IconPencil :size="14" stroke="2" />
          </button>
          <button type="button" class="queue-item-action" aria-label="删除排队消息" :disabled="!item.queuedInputId" draggable="false" @click="emit('delete', item.runId)">
            <IconTrash :size="14" stroke="2" />
          </button>
          <button
            v-if="item.holdReason"
            type="button"
            class="queue-item-action"
            aria-label="继续这条排队消息"
            draggable="false"
            @click="emit('resume', item.runId)"
          >
            <IconPlayerPlay :size="14" stroke="2" />
          </button>
          <button
            v-else
            type="button"
            class="queue-item-action"
            aria-label="暂停这条排队消息"
            draggable="false"
            @click="emit('pause', item.runId)"
          >
            <IconPlayerPause :size="14" stroke="2" />
          </button>
          <button type="button" class="queue-item-action queue-item-action--promote" aria-label="中断当前请求并发送队列" title="中断当前请求并发送队列" draggable="false" @click="emit('force-send', item.runId)">
            <IconBolt :size="14" stroke="2" />
          </button>
        </div>
      </div>
      </div>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </CollapsibleContentBlock>
  </div>
</template>

<style scoped>
.queue-panel {
  position: relative;
  width: 100%;
  min-width: 0;
}

.queue-panel-collapsible {
  display: flex;
  flex-direction: column-reverse;
  gap: 2px;
  --lc-collapse-offset-y: 3px;
}

.queue-panel-collapsible :deep(.lc-collapsible-summary) {
  min-height: 26px;
  padding: 2px var(--space-1);
  border-radius: 4px;
  background: var(--vscode-list-inactiveSelectionBackground, transparent);
}

.queue-panel-collapsible :deep(.lc-collapsible-summary:hover),
.queue-panel-collapsible :deep(.lc-collapsible-summary:focus-visible) {
  background: var(--vscode-list-hoverBackground, transparent);
}

.queue-panel-collapsible :deep(.lc-collapsible-content-frame) {
  position: relative;
}

.queue-panel-collapsible :deep(.lc-collapse-chevron) {
  transform: rotate(90deg);
}

.queue-panel-collapsible :deep(.lc-collapse-chevron.is-expanded) {
  transform: rotate(-90deg);
}

.queue-panel-title {
  flex: 0 0 auto;
  color: var(--vscode-foreground);
  font-weight: 500;
}

.queue-panel-summary {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: var(--space-2);
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-panel-scroll {
  max-height: 112px;
  overflow-y: auto;
  scrollbar-width: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.queue-panel-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.queue-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 26px;
  padding: 0 var(--space-1);
  border: 1px solid transparent;
  border-radius: 4px;
  background: var(--vscode-list-inactiveSelectionBackground, transparent);
  font-size: var(--font-size-sm);
  color: var(--vscode-descriptionForeground);
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}

.queue-item:hover {
  background: var(--vscode-list-hoverBackground, transparent);
}

.queue-item.is-held {
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.queue-item.is-dragging {
  opacity: 0.45;
}

.queue-item.is-drag-over-before {
  border-top-color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
}

.queue-item.is-drag-over-after {
  border-bottom-color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
}

.queue-drag-handle {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 22px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.6;
  cursor: grab;
}

.queue-item:active .queue-drag-handle {
  cursor: grabbing;
}

.queue-item-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.queue-item-index {
  flex: 0 0 auto;
  min-width: 14px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  opacity: 0.6;
}

.queue-item-status {
  flex: 0 0 auto;
  max-width: 90px;
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  line-height: 17px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-item-status.is-held {
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
}

.queue-item-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.queue-item-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.queue-item:hover .queue-item-actions,
.queue-item:focus-within .queue-item-actions {
  opacity: 1;
}

.queue-item-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-width: 22px;
  min-height: 22px;
  padding: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  transition: color 0.12s ease, background 0.12s ease;
}

.queue-item-action:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.12));
}

.queue-item-action:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  opacity: 0.45;
  cursor: not-allowed;
}

.queue-item-action--promote:hover:not(:disabled) {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.queue-hold-banner-action {
  flex: 0 0 auto;
  min-height: 22px;
  padding: 0 var(--space-2);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border-color: transparent;
}

.queue-hold-banner-action:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.queue-panel :deep(.advanced-scrollbar) {
  top: 2px;
  right: 0;
  bottom: 2px;
}
</style>
