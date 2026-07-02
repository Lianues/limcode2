<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { IconGitCommit } from '@tabler/icons-vue';
import type { CheckpointMarkerView } from '@webview/stores/useConversationUiStore';
import CheckpointTimelineCard from './CheckpointTimelineCard.vue';

interface MarkerPositionView {
  marker: CheckpointMarkerView;
  top: number;
  minTop: number;
  maxTop: number;
}

const props = withDefaults(defineProps<{
  markers: CheckpointMarkerView[];
  scroller?: HTMLElement | null;
}>(), {
  scroller: null
});

const emit = defineEmits<{
  (event: 'toggle', rowId: string): void;
}>();

const rootRef = ref<HTMLElement | null>(null);
const markerViews = ref<MarkerPositionView[]>([]);

const MARKER_BUTTON_SIZE = 18;
const MARKER_BUTTON_HALF = MARKER_BUTTON_SIZE / 2;

let attachedScroller: HTMLElement | null = null;
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let syncFrame = 0;

watch(() => props.scroller, attachScroller, { immediate: true, flush: 'post' });
watch(
  () => props.markers.map((marker) => `${marker.id}:${marker.checkpoint.status}:${marker.expanded}:${marker.floorMessageId ?? ''}:${marker.position ?? ''}`).join('\n'),
  () => void nextTick(scheduleSync),
  { flush: 'post' }
);

onBeforeUnmount(() => {
  detachScroller();
  if (syncFrame) window.cancelAnimationFrame(syncFrame);
});

function attachScroller(element: HTMLElement | null | undefined): void {
  detachScroller();
  if (!element) return;

  attachedScroller = element;
  element.addEventListener('scroll', scheduleSync, { passive: true });

  resizeObserver = new ResizeObserver(scheduleSync);
  resizeObserver.observe(element);
  if (element.firstElementChild instanceof HTMLElement) resizeObserver.observe(element.firstElementChild);
  if (rootRef.value) resizeObserver.observe(rootRef.value);

  mutationObserver = new MutationObserver(scheduleSync);
  mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });

  void nextTick(scheduleSync);
}

function detachScroller(): void {
  if (attachedScroller) attachedScroller.removeEventListener('scroll', scheduleSync);
  attachedScroller = null;
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  mutationObserver?.disconnect();
  mutationObserver = undefined;
}

function scheduleSync(): void {
  if (syncFrame) return;
  syncFrame = window.requestAnimationFrame(() => {
    syncFrame = 0;
    syncMarkerViews();
  });
}

function syncMarkerViews(): void {
  const root = rootRef.value;
  const scroller = attachedScroller;
  if (!root || !scroller) {
    markerViews.value = [];
    return;
  }

  const rootRect = root.getBoundingClientRect();
  const rootHeight = rootRect.height;
  const next = props.markers
    .map((marker): MarkerPositionView | undefined => {
      const geometry = geometryForMarker(marker, rootRect);
      if (!geometry || geometry.top < -24 || geometry.top > rootHeight + 24) return undefined;
      return { marker, ...geometry };
    })
    .filter((view): view is MarkerPositionView => view !== undefined)
    .sort((left, right) => left.top - right.top || left.marker.id.localeCompare(right.marker.id));

  markerViews.value = avoidMarkerOverlap(next, rootHeight);
}

function geometryForMarker(marker: CheckpointMarkerView, rootRect: DOMRect): Omit<MarkerPositionView, 'marker'> | undefined {
  if (marker.position === 'start') {
    return {
      top: 12,
      minTop: MARKER_BUTTON_HALF,
      maxTop: Math.max(MARKER_BUTTON_HALF, rootRect.height - MARKER_BUTTON_HALF)
    };
  }
  if (!marker.floorMessageId) return undefined;

  const target = findMarkerTarget(marker.floorMessageId);
  if (!target) return undefined;

  return contentColumnBoundaryGeometry(target, rootRect, marker.position);
}

function findMarkerTarget(messageId: string): HTMLElement | undefined {
  const scroller = attachedScroller;
  if (!scroller) return undefined;
  return Array.from(scroller.querySelectorAll<HTMLElement>('[data-scroll-marker-id]')).find(
    (candidate) => candidate.dataset.scrollMarkerId === messageId
  );
}

function contentColumnBoundaryGeometry(
  target: HTMLElement,
  rootRect: DOMRect,
  position: CheckpointMarkerView['position']
): Omit<MarkerPositionView, 'marker'> {
  const contentColumn = target.querySelector<HTMLElement>('.floor-content-column');
  const rect = (contentColumn ?? target).getBoundingClientRect();
  const topBoundary = rect.top - rootRect.top;
  const bottomBoundary = rect.bottom - rootRect.top;
  const minTop = topBoundary + MARKER_BUTTON_HALF;
  const maxTop = Math.max(minTop, bottomBoundary - MARKER_BUTTON_HALF);
  return {
    top: position === 'after' ? maxTop : minTop,
    minTop,
    maxTop
  };
}

function avoidMarkerOverlap(views: MarkerPositionView[], rootHeight: number): MarkerPositionView[] {
  const minGap = 22;
  let previousTop = -Infinity;
  const rootMinTop = MARKER_BUTTON_HALF;
  const rootMaxTop = Math.max(rootMinTop, rootHeight - MARKER_BUTTON_HALF);
  return views.map((view) => {
    const minTop = clamp(view.minTop, rootMinTop, rootMaxTop);
    const maxTop = clamp(view.maxTop, minTop, rootMaxTop);
    const top = clamp(Math.max(view.top, previousTop + minGap), minTop, maxTop);
    previousTop = top;
    return { ...view, top };
  });
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function toggleMarker(marker: CheckpointMarkerView): void {
  emit('toggle', marker.id);
  void nextTick(scheduleSync);
}

function markerLabel(marker: CheckpointMarkerView): string {
  return `${triggerLabel(marker)} · ${statusLabel(marker.checkpoint.status)}`;
}

function markerAriaLabel(marker: CheckpointMarkerView): string {
  return marker.expanded ? `收起存档点：${markerLabel(marker)}` : `展开存档点：${markerLabel(marker)}`;
}

function statusLabel(status: CheckpointMarkerView['checkpoint']['status']): string {
  switch (status) {
    case 'pending': return '创建中';
    case 'created': return '已创建';
    case 'skipped': return '已跳过';
    case 'failed': return '创建失败';
  }
}

function triggerLabel(marker: CheckpointMarkerView): string {
  switch (marker.checkpoint.trigger) {
    case 'conversation_initial': return '初始存档';
    case 'user_message_before': return '用户消息前';
    case 'user_message_after': return '用户消息后';
    case 'llm_response_before': return '调用 AI 前';
    case 'llm_response_after': return '调用 AI 后';
    case 'tool_execution_before': return '工具执行前';
    case 'tool_execution_after': return '工具执行后';
    case 'agent_run_completed_before': return '回合完成前';
    case 'agent_run_completed_after': return '回合完成后';
    case 'manual': return '手动存档';
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
</script>

<template>
  <div ref="rootRef" class="conversation-timeline-markers" aria-label="对话时间线标记">
    <div
      v-for="view in markerViews"
      :key="view.marker.id"
      class="checkpoint-marker-node"
      :style="{ top: `${view.top}px` }"
    >
      <button
        type="button"
        class="checkpoint-marker-button"
        :class="[`is-${view.marker.checkpoint.status}`, { 'is-expanded': view.marker.expanded }]"
        :aria-label="markerAriaLabel(view.marker)"
        :aria-pressed="view.marker.expanded"
        @click="toggleMarker(view.marker)"
      >
        <IconGitCommit class="checkpoint-marker-icon" stroke="2" aria-hidden="true" />
      </button>
      <Transition name="checkpoint-marker-panel">
        <div v-if="view.marker.expanded" class="checkpoint-marker-panel">
          <CheckpointTimelineCard
            :checkpoint="view.marker.checkpoint"
            :anchor="view.marker.anchor"
            phase="entering"
            variant="panel"
          />
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.conversation-timeline-markers {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: var(--conversation-timeline-marker-width, 24px);
  z-index: 4;
  pointer-events: none;
}

.checkpoint-marker-node {
  position: absolute;
  left: 0;
  width: 100%;
  height: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
}

.checkpoint-marker-button {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: auto;
  width: 18px;
  height: 18px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease,
    transform 120ms ease;
}

.checkpoint-marker-button:hover,
.checkpoint-marker-button:focus-visible,
.checkpoint-marker-button.is-expanded {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-foreground) 16%);
  outline: none;
}

.checkpoint-marker-button:active {
  transform: translate(-50%, calc(-50% + 1px));
}

.checkpoint-marker-button.is-pending {
  animation: checkpoint-marker-pending 1.1s ease-in-out infinite;
}

.checkpoint-marker-button.is-created {
  color: var(--vscode-foreground);
}

.checkpoint-marker-button.is-skipped {
  opacity: 0.72;
}

.checkpoint-marker-button.is-failed {
  color: var(--vscode-errorForeground);
}

.checkpoint-marker-icon {
  width: 12px;
  height: 12px;
}

.checkpoint-marker-panel {
  position: absolute;
  top: 0;
  left: var(--conversation-timeline-marker-width, 24px);
  width: min(560px, calc(100vw - 72px));
  max-width: calc(100vw - 72px);
  transform: translateY(-50%);
  pointer-events: auto;
  z-index: 7;
}

.checkpoint-marker-panel-enter-active,
.checkpoint-marker-panel-leave-active {
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.checkpoint-marker-panel-enter-from,
.checkpoint-marker-panel-leave-to {
  opacity: 0;
  transform: translateY(calc(-50% + 4px));
}

@keyframes checkpoint-marker-pending {
  0%,
  100% {
    opacity: 0.58;
  }
  50% {
    opacity: 1;
  }
}
</style>
