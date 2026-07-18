<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconChevronLeft, IconChevronRight, IconMessageQuestion } from '@tabler/icons-vue';
import { askUserRequestFromArgs } from '@shared/askUser';
import { ASK_USER_TOOL_NAME, type AskUserToolRequestRecord, type ToolCallRecord } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import CollapsibleContentBlock from '@webview/components/content/CollapsibleContentBlock.vue';
import { useAskUserStore } from '@webview/stores/useAskUserStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import AskUserContent from './AskUserContent.vue';

interface PendingAskUserView {
  toolCall: ToolCallRecord;
  request: AskUserToolRequestRecord;
}

interface PendingAskUserBatchView {
  key: string;
  runId?: string;
  items: PendingAskUserView[];
}

const askUser = useAskUserStore();
const conversationTimeline = useConversationTimelineStore();
const expanded = ref(true);
const scroller = ref<HTMLElement | null>(null);
const activeIndexByBatch = ref<Record<string, number>>({});

const pendingBatches = computed<PendingAskUserBatchView[]>(() => {
  const state = conversationTimeline.currentTimeline.state;
  const runIdByToolCallId = new Map(
    state.toolCallRunLinks.map((link) => [link.toolCallId, link.runId])
  );
  const batches = new Map<string, PendingAskUserBatchView>();

  for (const toolCall of state.toolCalls) {
    if (toolCall.name !== ASK_USER_TOOL_NAME || toolCall.status !== 'awaiting_user_input') continue;
    const request = askUserRequestFromArgs(toolCall.args);
    if (!request) continue;
    const runId = runIdByToolCallId.get(toolCall.id);
    // 同一 Run 同时处于 awaiting_user_input 的调用就是当前活动并行批；后续批次仍为 queued。
    const key = runId ? `run:${runId}` : `message:${toolCall.messageId}`;
    const batch = batches.get(key) ?? { key, ...(runId ? { runId } : {}), items: [] };
    batch.items.push({ toolCall, request });
    batches.set(key, batch);
  }

  return [...batches.values()]
    .map((batch) => ({
      ...batch,
      items: batch.items.sort((left, right) => left.toolCall.createdAt - right.toolCall.createdAt || left.toolCall.id.localeCompare(right.toolCall.id))
    }))
    .sort((left, right) => {
      const leftAt = left.items[0]?.toolCall.createdAt ?? 0;
      const rightAt = right.items[0]?.toolCall.createdAt ?? 0;
      return leftAt - rightAt || left.key.localeCompare(right.key);
    });
});

const pendingQuestionCount = computed(() => pendingBatches.value.reduce((count, batch) => count + batch.items.length, 0));
const activeQuestionLabel = computed(() => {
  const firstBatch = pendingBatches.value[0];
  return firstBatch ? activeQuestion(firstBatch).request.question : '';
});
const panelSummary = computed(() => {
  const countLabel = `${pendingQuestionCount.value} 个问题等待回答`;
  return activeQuestionLabel.value ? `${countLabel} · ${activeQuestionLabel.value}` : countLabel;
});
const refreshKey = computed(() => `${expanded.value ? 'expanded' : 'collapsed'}:${pendingBatches.value
  .map((batch) => `${batch.key}:${activeIndex(batch)}:${batch.items.map(({ toolCall }) => `${toolCall.id}:${toolCall.updatedAt}`).join(',')}`)
  .join('|')}`);

watch(
  () => pendingBatches.value.map((batch) => `${batch.key}:${batch.items.map((item) => item.toolCall.id).join(',')}`).join('|'),
  () => {
    const next: Record<string, number> = {};
    for (const batch of pendingBatches.value) {
      next[batch.key] = Math.min(activeIndexByBatch.value[batch.key] ?? 0, Math.max(0, batch.items.length - 1));
    }
    activeIndexByBatch.value = next;
  },
  { immediate: true }
);

watch(pendingQuestionCount, (nextCount, previousCount) => {
  // 收起状态只作用于当前这轮等待；问题全部结束后，下次提问仍默认展开。
  if (nextCount === 0 && previousCount > 0) expanded.value = true;
});

watch(
  () => conversationTimeline.currentTimeline.state.toolCalls
    .filter((call) => call.name === ASK_USER_TOOL_NAME)
    .map((call) => `${call.id}:${call.status}`)
    .join('|'),
  () => {
    for (const call of conversationTimeline.currentTimeline.state.toolCalls) {
      if (call.name === ASK_USER_TOOL_NAME && call.status !== 'awaiting_user_input') askUser.clearDraft(call.id);
    }
  },
  { immediate: true }
);

function activeIndex(batch: PendingAskUserBatchView): number {
  return Math.min(activeIndexByBatch.value[batch.key] ?? 0, Math.max(0, batch.items.length - 1));
}

function activeQuestion(batch: PendingAskUserBatchView): PendingAskUserView {
  return batch.items[activeIndex(batch)]!;
}

function move(batch: PendingAskUserBatchView, delta: number): void {
  if (batch.items.length <= 1) return;
  const next = (activeIndex(batch) + delta + batch.items.length) % batch.items.length;
  activeIndexByBatch.value = { ...activeIndexByBatch.value, [batch.key]: next };
}

function selectQuestion(batch: PendingAskUserBatchView, index: number): void {
  if (index < 0 || index >= batch.items.length) return;
  activeIndexByBatch.value = { ...activeIndexByBatch.value, [batch.key]: index };
}
</script>

<template>
  <section v-if="pendingBatches.length" class="ask-user-top-panel" aria-live="polite">
    <CollapsibleContentBlock
      v-model:expanded="expanded"
      class="ask-user-top-collapsible"
      aria-label="展开或收起待回答问题"
      kind="input"
    >
      <template #icon>
        <IconMessageQuestion stroke="2" aria-hidden="true" />
      </template>
      <template #summary>
        <span class="ask-user-top-title">回答 AI 的问题</span>
        <span class="ask-user-top-summary">{{ panelSummary }}</span>
      </template>

      <div v-if="expanded" class="ask-user-top-scroll-shell">
        <div ref="scroller" class="ask-user-top-scroll">
          <section v-for="batch in pendingBatches" :key="batch.key" class="ask-user-batch">
            <nav v-if="batch.items.length > 1" class="ask-user-batch-nav" aria-label="切换同批待回答问题">
              <span class="ask-user-batch-progress">问题 {{ activeIndex(batch) + 1 }} / {{ batch.items.length }}</span>
              <div class="ask-user-batch-dots" aria-label="选择问题">
                <button
                  v-for="(_, index) in batch.items"
                  :key="`${batch.key}-dot-${index}`"
                  type="button"
                  class="ask-user-batch-dot"
                  :class="{ 'is-active': activeIndex(batch) === index }"
                  :aria-label="`查看第 ${index + 1} 个问题`"
                  :aria-current="activeIndex(batch) === index ? 'step' : undefined"
                  @click="selectQuestion(batch, index)"
                ></button>
              </div>
              <button type="button" class="ask-user-batch-switch" aria-label="上一个问题" @click="move(batch, -1)">
                <IconChevronLeft stroke="2" aria-hidden="true" />
              </button>
              <button type="button" class="ask-user-batch-switch" aria-label="下一个问题" @click="move(batch, 1)">
                <IconChevronRight stroke="2" aria-hidden="true" />
              </button>
            </nav>

            <AskUserContent
              :key="activeQuestion(batch).toolCall.id"
              :request="activeQuestion(batch).request"
              :tool-call="activeQuestion(batch).toolCall"
              placement="composer"
            />
          </section>
        </div>
        <AdvancedScrollbar
          class="ask-user-top-scrollbar"
          :scroller="scroller"
          :refresh-key="refreshKey"
          variant="minimal"
        />
      </div>
    </CollapsibleContentBlock>
  </section>
</template>

<style scoped>
.ask-user-top-panel {
  width: 100%;
  min-width: 0;
}

.ask-user-top-collapsible {
  display: flex;
  flex-direction: column-reverse;
  gap: 2px;
  --lc-collapse-offset-y: 3px;
}

.ask-user-top-collapsible :deep(.lc-collapsible-summary) {
  min-height: 28px;
  padding: 2px var(--space-2);
  border-radius: 0;
  background: var(--vscode-list-inactiveSelectionBackground, transparent);
}

.ask-user-top-collapsible :deep(.lc-collapsible-summary:hover),
.ask-user-top-collapsible :deep(.lc-collapsible-summary:focus-visible) {
  background: var(--vscode-list-hoverBackground, transparent);
}

.ask-user-top-collapsible :deep(.lc-collapsible-content-frame) {
  position: relative;
}

.ask-user-top-collapsible :deep(.lc-collapse-chevron) {
  transform: rotate(90deg);
}

.ask-user-top-collapsible :deep(.lc-collapse-chevron.is-expanded) {
  transform: rotate(-90deg);
}

.ask-user-top-title {
  flex: 0 0 auto;
  color: var(--vscode-foreground);
  font-weight: 600;
}

.ask-user-top-summary {
  min-width: 0;
  margin-left: var(--space-2);
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ask-user-batch-progress {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.ask-user-top-scroll-shell {
  position: relative;
  min-width: 0;
  min-height: 0;
}

.ask-user-top-scroll {
  max-height: min(180px, 24vh);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-right: 14px;
  scrollbar-width: none;
}

.ask-user-top-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.ask-user-batch {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.ask-user-batch-nav {
  min-height: 24px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
}

.ask-user-batch-progress {
  margin-right: auto;
}

.ask-user-batch-dots {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ask-user-batch-dot {
  width: 18px;
  height: 18px;
  border: 0;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  cursor: pointer;
}

.ask-user-batch-dot::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 44%, transparent);
}

.ask-user-batch-dot:hover::before,
.ask-user-batch-dot:focus-visible::before,
.ask-user-batch-dot.is-active::before {
  background: var(--vscode-foreground);
}

.ask-user-batch-dot:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--vscode-foreground) 54%, transparent);
  outline-offset: -3px;
}

.ask-user-batch-switch {
  width: 24px;
  height: 24px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  padding: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
}

.ask-user-batch-switch:hover,
.ask-user-batch-switch:focus-visible {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-foreground) 16%);
  outline: none;
}

.ask-user-batch-switch :deep(svg) {
  width: 16px;
  height: 16px;
}

.ask-user-top-scrollbar {
  inset: 2px 1px 2px auto;
}
</style>
