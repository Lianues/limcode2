<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, watch, ref } from 'vue';
import type { ConversationTimelineViewRow } from '@webview/stores/useConversationUiStore';

const props = withDefaults(defineProps<{
  rows: ConversationTimelineViewRow[];
  scroller?: HTMLElement | null;
  itemKey?: (row: ConversationTimelineViewRow, index: number) => string;
  estimatedHeight?: number;
  overscan?: number;
}>(), {
  scroller: null,
  itemKey: undefined,
  estimatedHeight: 180,
  overscan: 6
});

defineSlots<{
  default(props: { row: ConversationTimelineViewRow; index: number }): unknown;
}>();

const scrollTop = ref(0);
const viewportHeight = ref(0);
const measuredHeights = ref<Record<string, number>>({});

interface ScrollAnchorSnapshot {
  mode: 'row' | 'bottom';
  rowKey?: string;
  offsetWithinRow?: number;
  distanceFromBottom?: number;
}

const BOTTOM_ANCHOR_THRESHOLD_PX = 4;

let attachedScroller: HTMLElement | null = null;
let scrollerResizeObserver: ResizeObserver | undefined;
let rowResizeObserver: ResizeObserver | undefined;
const observedRowElements = new Map<string, HTMLElement>();
const observedElementKeys = new WeakMap<HTMLElement, string>();
let pendingAnchor: ScrollAnchorSnapshot | undefined;
let restoreScheduled = false;

const rowKeys = computed(() => props.rows.map((row, index) => keyFor(row, index)));
const rowKeySignature = computed(() => rowKeys.value.join('\u0001'));
const rowHeights = computed(() => rowKeys.value.map((key) => measuredHeights.value[key] ?? props.estimatedHeight));
const offsets = computed(() => {
  const result: number[] = [];
  let offset = 0;
  for (const height of rowHeights.value) {
    result.push(offset);
    offset += height;
  }
  return result;
});
const totalHeight = computed(() => rowHeights.value.reduce((sum, height) => sum + height, 0));
const visibleRange = computed(() => {
  const rowCount = props.rows.length;
  if (rowCount === 0) return { start: 0, end: 0 };

  const maxScrollTop = Math.max(0, totalHeight.value - viewportHeight.value);
  const effectiveScrollTop = clamp(scrollTop.value, 0, maxScrollTop);
  const startY = Math.max(0, effectiveScrollTop - props.overscan * props.estimatedHeight);
  const endY = effectiveScrollTop + viewportHeight.value + props.overscan * props.estimatedHeight;
  let start = 0;
  while (start < offsets.value.length && offsets.value[start] + rowHeights.value[start] < startY) start += 1;
  start = clampStartIndex(start, rowCount);
  let end = start;
  while (end < offsets.value.length && offsets.value[end] < endY) end += 1;
  end = clampEndIndex(Math.max(end, start + 1), rowCount);
  return { start, end };
});
const visibleItems = computed(() => props.rows.slice(visibleRange.value.start, visibleRange.value.end));
const topSpacerHeight = computed(() => offsets.value[visibleRange.value.start] ?? 0);
const renderedHeight = computed(() => {
  let sum = 0;
  for (let index = visibleRange.value.start; index < visibleRange.value.end; index += 1) sum += rowHeights.value[index] ?? props.estimatedHeight;
  return sum;
});
const bottomSpacerHeight = computed(() => Math.max(0, totalHeight.value - topSpacerHeight.value - renderedHeight.value));

watch(() => props.scroller, attachScroller, { immediate: true, flush: 'post' });
watch(rowKeySignature, () => {
  scheduleAnchorRestore();
  pruneRemovedRows();
  void nextTick(syncScroller);
}, { flush: 'pre' });
onBeforeUnmount(detachScroller);

function keyFor(row: ConversationTimelineViewRow, index: number): string {
  return props.itemKey?.(row, index) ?? row.id ?? String(index);
}

function attachScroller(element: HTMLElement | null | undefined): void {
  detachScroller();
  if (!element) return;
  attachedScroller = element;
  element.addEventListener('scroll', syncScroller, { passive: true });
  scrollerResizeObserver = new ResizeObserver(syncScroller);
  scrollerResizeObserver.observe(element);
  rowResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (!(entry.target instanceof HTMLElement)) continue;
      const key = observedElementKeys.get(entry.target);
      if (!key) continue;
      measureRowElement(key, entry.target);
    }
    syncScroller();
  });
  for (const [key, rowElement] of observedRowElements) {
    observedElementKeys.set(rowElement, key);
    rowResizeObserver.observe(rowElement);
  }
  syncScroller();
}

function detachScroller(): void {
  if (attachedScroller) attachedScroller.removeEventListener('scroll', syncScroller);
  scrollerResizeObserver?.disconnect();
  scrollerResizeObserver = undefined;
  rowResizeObserver?.disconnect();
  rowResizeObserver = undefined;
  attachedScroller = null;
  pendingAnchor = undefined;
  restoreScheduled = false;
}

function syncScroller(): void {
  const element = attachedScroller;
  const nextViewportHeight = element?.clientHeight ?? 0;
  viewportHeight.value = nextViewportHeight;
  const scrollHeight = element?.scrollHeight ?? totalHeight.value;
  const maxScrollTop = Math.max(0, scrollHeight - nextViewportHeight);
  const nextScrollTop = clamp(element?.scrollTop ?? 0, 0, maxScrollTop);
  if (element && element.scrollTop !== nextScrollTop) element.scrollTop = nextScrollTop;
  scrollTop.value = nextScrollTop;
}

function scheduleAnchorRestore(anchor: ScrollAnchorSnapshot | undefined = snapshotScrollAnchor()): void {
  if (!anchor) return;
  pendingAnchor = anchor;
  if (restoreScheduled) return;
  restoreScheduled = true;
  void nextTick(() => {
    restoreScheduled = false;
    restorePendingAnchor();
  });
}

function snapshotScrollAnchor(): ScrollAnchorSnapshot | undefined {
  const element = attachedScroller;
  if (!element || rowKeys.value.length === 0) return undefined;

  const bottomAnchor = snapshotBottomAnchor(element, element.scrollHeight);
  if (bottomAnchor) return bottomAnchor;

  const scrollerRect = element.getBoundingClientRect();
  const anchorEntry = [...observedRowElements.entries()]
    .map(([key, rowElement]) => ({ key, rowElement, rect: rowElement.getBoundingClientRect() }))
    .filter((item) => item.rect.bottom > scrollerRect.top + 1)
    .sort((left, right) => left.rect.top - right.rect.top)[0];
  if (!anchorEntry) return undefined;
  const rowTop = anchorEntry.rect.top - scrollerRect.top + element.scrollTop;
  return {
    mode: 'row',
    rowKey: anchorEntry.key,
    offsetWithinRow: Math.max(0, element.scrollTop - rowTop)
  };
}

function snapshotVirtualBottomAnchor(): ScrollAnchorSnapshot | undefined {
  const element = attachedScroller;
  if (!element || rowKeys.value.length === 0) return undefined;
  return snapshotBottomAnchor(element, Math.max(totalHeight.value, element.clientHeight));
}

function snapshotBottomAnchor(element: HTMLElement, scrollHeight: number): ScrollAnchorSnapshot | undefined {
  const distanceFromBottom = Math.max(0, scrollHeight - element.scrollTop - element.clientHeight);
  return distanceFromBottom <= BOTTOM_ANCHOR_THRESHOLD_PX
    ? { mode: 'bottom', distanceFromBottom }
    : undefined;
}

function restorePendingAnchor(): void {
  const anchor = pendingAnchor;
  pendingAnchor = undefined;
  const element = attachedScroller;
  if (!anchor || !element) return;

  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  if (anchor.mode === 'bottom') {
    element.scrollTop = clamp(maxScrollTop - Math.max(0, anchor.distanceFromBottom ?? 0), 0, maxScrollTop);
    syncScroller();
    return;
  }

  const index = anchor.rowKey ? rowKeys.value.indexOf(anchor.rowKey) : -1;
  if (index < 0) return;
  const nextScrollTop = (offsets.value[index] ?? 0) + Math.max(0, anchor.offsetWithinRow ?? 0);
  element.scrollTop = clamp(nextScrollTop, 0, maxScrollTop);
  syncScroller();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampStartIndex(value: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  return Math.min(rowCount - 1, Math.max(0, value));
}

function clampEndIndex(value: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  return Math.min(rowCount, Math.max(0, value));
}

function pruneRemovedRows(): void {
  const validKeys = new Set(rowKeys.value);
  for (const [key, element] of [...observedRowElements.entries()]) {
    if (validKeys.has(key)) continue;
    rowResizeObserver?.unobserve(element);
    observedRowElements.delete(key);
    observedElementKeys.delete(element);
  }
}

function setRowElement(row: ConversationTimelineViewRow, absoluteIndex: number, element: Element | null): void {
  const key = keyFor(row, absoluteIndex);
  const previousElement = observedRowElements.get(key);
  if (previousElement && previousElement !== element) {
    rowResizeObserver?.unobserve(previousElement);
    observedRowElements.delete(key);
    observedElementKeys.delete(previousElement);
  }

  if (!(element instanceof HTMLElement)) return;

  const previousKey = observedElementKeys.get(element);
  if (previousKey && previousKey !== key) {
    observedRowElements.delete(previousKey);
    rowResizeObserver?.unobserve(element);
  }

  observedRowElements.set(key, element);
  observedElementKeys.set(element, key);
  rowResizeObserver?.observe(element);
  measureRowElement(key, element);
}

function measureRowElement(key: string, element: HTMLElement): void {
  const height = Math.max(1, Math.ceil(element.getBoundingClientRect().height));
  if (measuredHeights.value[key] === height) return;
  scheduleAnchorRestore(snapshotVirtualBottomAnchor() ?? snapshotScrollAnchor());
  measuredHeights.value = { ...measuredHeights.value, [key]: height };
}
</script>

<template>
  <div class="virtual-timeline-list" :style="{ minHeight: `${totalHeight}px` }">
    <div v-if="topSpacerHeight > 0" class="virtual-timeline-spacer" :style="{ height: `${topSpacerHeight}px` }" />
    <div
      v-for="(row, localIndex) in visibleItems"
      :key="keyFor(row, visibleRange.start + localIndex)"
      :ref="(element) => setRowElement(row, visibleRange.start + localIndex, element as Element | null)"
      class="virtual-timeline-row"
    >
      <slot :row="row" :index="visibleRange.start + localIndex" />
    </div>
    <div v-if="bottomSpacerHeight > 0" class="virtual-timeline-spacer" :style="{ height: `${bottomSpacerHeight}px` }" />
  </div>
</template>

<style scoped>
.virtual-timeline-list {
  position: relative;
  min-width: 0;
  overflow-anchor: none;
}

.virtual-timeline-spacer {
  flex: 0 0 auto;
  pointer-events: none;
}

.virtual-timeline-row {
  min-width: 0;
}
</style>
