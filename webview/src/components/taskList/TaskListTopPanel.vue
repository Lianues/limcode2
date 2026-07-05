<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconChevronRight, IconListNumbers } from '@tabler/icons-vue';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import TaskListDisplay from './TaskListDisplay.vue';
import {
  applyTaskListOperationsAfterMessageSeq,
  buildTaskListTimeline,
  emptyTaskListSnapshot,
  formatTaskListProgress,
  type TaskListSnapshotView
} from './taskListModel';
import type { TimelineProjectionContextRecord } from '@shared/timelineProjection';

const clientState = useClientStateStore();
const conversationTimeline = useConversationTimelineStore();
const expanded = ref(false);
const listScroller = ref<HTMLElement | null>(null);

const timeline = computed(() => buildTaskListTimeline({
  messages: conversationTimeline.currentTimeline.state.messages,
  toolCalls: conversationTimeline.currentTimeline.state.toolCalls,
  conversationId: clientState.currentConversationId
}));
const snapshot = computed<TaskListSnapshotView>(() => {
  const projection = conversationTimeline.currentTaskListProjection as TimelineProjectionContextRecord<TaskListSnapshotView> | undefined;
  if (!projection?.latestSnapshot) return timeline.value.snapshot ?? emptyTaskListSnapshot();

  if (conversationTimeline.currentTimeline.hasStreamSnapshot) {
    const liveTimeline = timeline.value;
    if (liveTimeline.entries.length > 0 || projection.latestSnapshot.stats.total === 0) {
      return liveTimeline.snapshot ?? emptyTaskListSnapshot();
    }
  }

  return applyTaskListOperationsAfterMessageSeq({
    snapshot: projection.latestSnapshot,
    messages: conversationTimeline.currentTimeline.state.messages,
    toolCalls: conversationTimeline.currentTimeline.state.toolCalls,
    conversationId: clientState.currentConversationId,
    minSeqExclusive: projection.latestChunkEndSeq
  });
});
const visible = computed(() => snapshot.value.items.length > 0);
const progressLabel = computed(() => formatTaskListProgress(snapshot.value));
const activeLabel = computed(() => {
  const active = snapshot.value.activeItem;
  return active ? active.description || active.title : '';
});
const statsLabel = computed(() => {
  const stats = snapshot.value.stats;
  return `${stats.completed}/${stats.total} 已完成`;
});
const refreshKey = computed(() => snapshot.value.items.map((item) => `${item.key}:${item.status}:${item.updatedOrder}`).join('|'));

watch(() => clientState.currentConversationId, () => {
  expanded.value = false;
});

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <section v-if="visible" class="task-list-top-panel" :class="{ 'is-expanded': expanded }" :title="progressLabel">
    <button
      type="button"
      class="task-list-top-header"
      :aria-expanded="expanded"
      aria-label="展开或收起任务清单"
      @click="toggleExpanded"
    >
      <IconListNumbers class="task-list-top-icon" stroke="2" aria-hidden="true" />
      <span class="task-list-top-title">任务清单</span>
      <span class="task-list-top-stats">{{ statsLabel }}</span>
      <span v-if="activeLabel" class="task-list-top-active">当前：{{ activeLabel }}</span>
      <IconChevronRight
        class="task-list-top-chevron lc-collapse-chevron"
        :class="{ 'is-expanded': expanded }"
        stroke="2"
        aria-hidden="true"
      />
    </button>

    <div class="task-list-top-body lc-collapse-shell" :class="{ 'is-expanded': expanded }" :aria-hidden="!expanded">
      <div class="task-list-top-body-frame lc-collapse-frame">
        <div class="task-list-top-body-content">
          <div class="task-list-top-scroll-shell">
            <div ref="listScroller" class="task-list-top-scroll">
              <TaskListDisplay :items="snapshot.items" density="compact" :show-description="false" />
            </div>
            <AdvancedScrollbar :scroller="listScroller" :refresh-key="refreshKey" variant="minimal" />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.task-list-top-panel {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.task-list-top-header {
  width: 100%;
  min-height: 28px;
  border: 0;
  padding: 0 var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.task-list-top-header:hover,
.task-list-top-header:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.task-list-top-title {
  flex: 0 0 auto;
  font-weight: 600;
  font-size: var(--font-size-sm);
}

.task-list-top-stats,
.task-list-top-active {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.task-list-top-active {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-list-top-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
}

.task-list-top-chevron {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
}

.task-list-top-body-content {
  padding: 0 var(--conversation-content-padding-right, calc(var(--space-4) + 24px)) 8px
    var(--conversation-content-padding-left, var(--space-4));
}

.task-list-top-scroll-shell {
  position: relative;
  min-height: 0;
}

.task-list-top-scroll {
  max-height: 138px;
  overflow-y: auto;
  padding: 2px 14px 2px 0;
  scrollbar-width: none;
}

.task-list-top-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
</style>
