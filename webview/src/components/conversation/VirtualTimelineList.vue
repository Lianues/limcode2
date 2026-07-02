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

let attachedScroller: HTMLElement | null = null;
let scrollerResizeObserver: ResizeObserver | undefined;
let rowResizeObserver: ResizeObserver | undefined;
const observedRowElements = new Map<string, HTMLElement>();
const observedElementKeys = new WeakMap<HTMLElement, string>();

const rowKeys = computed(() => props.rows.map((row, index) => keyFor(row, index)));
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
  const startY = Math.max(0, scrollTop.value - props.overscan * props.estimatedHeight);
  const endY = scrollTop.value + viewportHeight.value + props.overscan * props.estimatedHeight;
  let start = 0;
  while (start < offsets.value.length && offsets.value[start] + rowHeights.value[start] < startY) start += 1;
  let end = start;
  while (end < offsets.value.length && offsets.value[end] < endY) end += 1;
  return { start, end: Math.max(end, start + 1) };
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
watch(() => props.rows.length, () => void nextTick(syncScroller), { flush: 'post' });
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
}

function syncScroller(): void {
  const element = attachedScroller;
  scrollTop.value = element?.scrollTop ?? 0;
  viewportHeight.value = element?.clientHeight ?? 0;
}

function setRowElement(row: ConversationTimelineViewRow, absoluteIndex: number, element: Element | null): void {
  const key = keyFor(row, absoluteIndex);
  const previousElement = observedRowElements.get(key);
  if (previousElement && previousElement !== element) {
    rowResizeObserver?.unobserve(previousElement);
    observedRowElements.delete(key);
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
}

.virtual-timeline-spacer {
  flex: 0 0 auto;
  pointer-events: none;
}

.virtual-timeline-row {
  min-width: 0;
}
</style>
