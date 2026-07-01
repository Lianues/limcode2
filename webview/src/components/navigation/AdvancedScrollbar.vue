<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

interface AdvancedScrollMarker {
  id: string;
  label: string;
  preview: string;
  kind?: string;
}

interface MarkerView extends AdvancedScrollMarker {
  top: number;
  targetTop: number;
}

const props = withDefaults(
  defineProps<{
    scroller: HTMLElement | null;
    markers?: AdvancedScrollMarker[];
    refreshKey?: unknown;
    showMarkers?: boolean;
    showEdgeButtons?: boolean;
    showMarkerPreview?: boolean;
    variant?: 'default' | 'minimal';
    orientation?: 'vertical' | 'horizontal';
  }>(),
  {
    markers: () => [],
    showMarkers: false,
    showEdgeButtons: false,
    showMarkerPreview: false,
    variant: 'default',
    orientation: 'vertical'
  }
);

const scrollbarRootRef = ref<HTMLElement | null>(null);
const trackRef = ref<HTMLElement | null>(null);
const markerPanelRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const scrollHeight = ref(0);
const clientHeight = ref(0);
const trackHeight = ref(0);
const rootHeight = ref(0);
const markerPanelHeight = ref(0);
const markerViews = ref<MarkerView[]>([]);
const panelOpen = ref(false);
const hoverTrackY = ref(0);
const activeMarkerId = ref<string | undefined>();
const dragging = ref(false);

let observedScroller: HTMLElement | null = null;
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let animationFrame = 0;
let dragStartY = 0;
let dragStartScrollTop = 0;
let closePanelTimer: number | undefined;

const panelBoundaryInset = 6;
const panelPaddingBlock = 16;
const panelGap = 5;
const panelTitleEstimatedHeight = 24;
const panelRowEstimatedHeight = 40;
const isHorizontal = computed(() => props.orientation === 'horizontal');
const maxScroll = computed(() => Math.max(0, scrollHeight.value - clientHeight.value));
const canScroll = computed(() => maxScroll.value > 1);
const thumbHeight = computed(() => {
  if (!trackHeight.value || !scrollHeight.value) return 0;
  const rawHeight = (clientHeight.value / scrollHeight.value) * trackHeight.value;
  return Math.min(trackHeight.value, Math.max(32, rawHeight));
});
const trackTravel = computed(() => Math.max(1, trackHeight.value - thumbHeight.value));
const thumbTop = computed(() => {
  if (!canScroll.value) return 0;
  return (scrollTop.value / maxScroll.value) * trackTravel.value;
});
const thumbStyle = computed(() => isHorizontal.value
  ? { width: `${thumbHeight.value}px`, transform: `translateX(${thumbTop.value}px)` }
  : { height: `${thumbHeight.value}px`, transform: `translateY(${thumbTop.value}px)` }
);
const trackOffsetTop = computed(() => {
  const root = scrollbarRootRef.value;
  const track = trackRef.value;
  if (!root || !track) return 22;
  return track.getBoundingClientRect().top - root.getBoundingClientRect().top;
});
const markerPanelMaxHeight = computed(() => {
  const available = (rootHeight.value || trackHeight.value + 44) - panelBoundaryInset * 2;
  return Math.max(32, Math.min(260, available || 260));
});
const markerPanelClampHeight = computed(() => {
  return Math.min(markerPanelHeight.value || markerPanelMaxHeight.value, markerPanelMaxHeight.value);
});
const panelTop = computed(() => {
  const root = rootHeight.value || trackHeight.value + 44;
  const halfPanel = markerPanelClampHeight.value / 2;
  const minTop = panelBoundaryInset + halfPanel;
  const maxTop = root - panelBoundaryInset - halfPanel;
  const desiredTop = trackOffsetTop.value + hoverTrackY.value;
  if (maxTop < minTop) return `${root / 2}px`;
  return `${clamp(desiredTop, minTop, maxTop)}px`;
});
const markerPanelStyle = computed(() => ({ top: panelTop.value, maxHeight: `${markerPanelMaxHeight.value}px` }));
const atTop = computed(() => scrollTop.value <= 1);
const atBottom = computed(() => scrollTop.value >= maxScroll.value - 1);
const visiblePanelMarkers = computed(() => {
  const markers = markerViews.value;
  if (!props.showMarkers || !panelOpen.value || !markers.length) return [];

  const panelCapacity = Math.max(
    1,
    Math.floor((markerPanelMaxHeight.value - panelPaddingBlock - panelTitleEstimatedHeight) / (panelRowEstimatedHeight + panelGap))
  );
  const radius = clamp(markerPanelMaxHeight.value * 0.42, 44, Math.max(56, trackHeight.value * 0.22));
  const nearby = markers.filter((marker) => Math.abs(marker.top - hoverTrackY.value) <= radius);
  const selected = nearby.length
    ? nearby
    : [...markers]
        .sort((left, right) => Math.abs(left.top - hoverTrackY.value) - Math.abs(right.top - hoverTrackY.value))
        .slice(0, 1);

  return selected
    .sort((left, right) => Math.abs(left.top - hoverTrackY.value) - Math.abs(right.top - hoverTrackY.value))
    .slice(0, panelCapacity)
    .sort((left, right) => left.top - right.top);
});

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function setScrollTop(value: number, behavior: ScrollBehavior = 'auto'): void {
  const element = props.scroller;
  if (!element) return;
  const nextValue = clamp(value, 0, maxScroll.value);
  if (isHorizontal.value) element.scrollTo({ left: nextValue, behavior });
  else element.scrollTo({ top: nextValue, behavior });
}

function scrollToTop(): void {
  setScrollTop(0, 'smooth');
}

function scrollToBottom(): void {
  setScrollTop(maxScroll.value, 'smooth');
}

function findMarkerElement(markerId: string): HTMLElement | undefined {
  const element = props.scroller;
  if (!element) return undefined;
  return Array.from(element.querySelectorAll<HTMLElement>('[data-scroll-marker-id]')).find(
    (candidate) => candidate.dataset.scrollMarkerId === markerId
  );
}

function targetTopForMarker(markerId: string): number | undefined {
  const element = props.scroller;
  const target = findMarkerElement(markerId);
  if (!element || !target) return undefined;

  const targetTop = target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
  return clamp(targetTop, 0, maxScroll.value);
}

function scrollToMarker(marker: MarkerView): void {
  activeMarkerId.value = marker.id;
  setScrollTop(marker.targetTop, 'smooth');
}

function rebuildMarkers(): void {
  const element = props.scroller;
  if (isHorizontal.value || !props.showMarkers || !element || !trackHeight.value || !canScroll.value) {
    markerViews.value = [];
    activeMarkerId.value = undefined;
    return;
  }

  const nextMarkers: MarkerView[] = [];

  for (const marker of props.markers) {
    const targetTop = targetTopForMarker(marker.id);
    if (targetTop === undefined) continue;
    const top = maxScroll.value > 0 ? (targetTop / maxScroll.value) * trackHeight.value : 0;
    nextMarkers.push({
      ...marker,
      targetTop,
      top: clamp(top, 0, Math.max(0, trackHeight.value - 2))
    });
  }

  markerViews.value = nextMarkers;
  if (activeMarkerId.value && !nextMarkers.some((marker) => marker.id === activeMarkerId.value)) {
    activeMarkerId.value = undefined;
  }
}

function syncMetrics(): void {
  animationFrame = 0;
  const element = props.scroller;
  const track = trackRef.value;
  if (!element) return;

  rootHeight.value = scrollbarRootRef.value?.clientHeight ?? 0;
  markerPanelHeight.value = markerPanelRef.value?.offsetHeight ?? 0;

  scrollTop.value = isHorizontal.value ? element.scrollLeft : element.scrollTop;
  scrollHeight.value = isHorizontal.value ? element.scrollWidth : element.scrollHeight;
  clientHeight.value = isHorizontal.value ? element.clientWidth : element.clientHeight;
  trackHeight.value = isHorizontal.value ? (track?.clientWidth ?? 0) : (track?.clientHeight ?? 0);
  if (!hoverTrackY.value && trackHeight.value) hoverTrackY.value = thumbTop.value + thumbHeight.value / 2;
  rebuildMarkers();
}

function scheduleSync(): void {
  if (animationFrame) return;
  animationFrame = window.requestAnimationFrame(syncMetrics);
}

function openPanel(event?: PointerEvent): void {
  cancelClosePanel();
  if (!canScroll.value || !props.showMarkers) return;
  panelOpen.value = true;
  if (event) updateHoverFromPointer(event);
  void nextTick(scheduleSync);
}

function closePanel(): void {
  cancelClosePanel();
  if (dragging.value) return;
  panelOpen.value = false;
  activeMarkerId.value = undefined;
}

function scheduleClosePanel(): void {
  cancelClosePanel();
  closePanelTimer = window.setTimeout(closePanel, 180);
}

function cancelClosePanel(): void {
  if (closePanelTimer === undefined) return;
  window.clearTimeout(closePanelTimer);
  closePanelTimer = undefined;
}

function isPointerInsideRect(event: PointerEvent, rect: DOMRect): boolean {
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function isPointerInsideInteractiveArea(event: PointerEvent): boolean {
  const rootRect = scrollbarRootRef.value?.getBoundingClientRect();
  const panelRect = markerPanelRef.value?.getBoundingClientRect();

  if (rootRect && isPointerInsideRect(event, rootRect)) return true;
  if (panelRect && isPointerInsideRect(event, panelRect)) return true;

  if (!rootRect || !panelRect) return false;

  const bridgeLeft = Math.min(panelRect.right, rootRect.left);
  const bridgeRight = Math.max(panelRect.right, rootRect.left);
  return (
    event.clientX >= bridgeLeft &&
    event.clientX <= bridgeRight &&
    event.clientY >= panelRect.top &&
    event.clientY <= panelRect.bottom
  );
}

function updateHoverFromPointer(event: PointerEvent): void {
  const track = trackRef.value;
  if (!track || !trackHeight.value) return;
  const rect = track.getBoundingClientRect();
  hoverTrackY.value = isHorizontal.value
    ? clamp(event.clientX - rect.left, 0, trackHeight.value)
    : clamp(event.clientY - rect.top, 0, trackHeight.value);
}

function onTrackPointerMove(event: PointerEvent): void {
  openPanel(event);
}

function onTrackPointerDown(event: PointerEvent): void {
  if (event.target !== trackRef.value || !canScroll.value) return;
  updateHoverFromPointer(event);

  const pointerPosition = hoverTrackY.value - thumbHeight.value / 2;
  const nextScrollTop = (clamp(pointerPosition, 0, trackTravel.value) / trackTravel.value) * maxScroll.value;
  setScrollTop(nextScrollTop, 'smooth');
}

function onThumbPointerDown(event: PointerEvent): void {
  if (!canScroll.value) return;
  event.preventDefault();
  openPanel(event);
  dragging.value = true;
  dragStartY = isHorizontal.value ? event.clientX : event.clientY;
  dragStartScrollTop = scrollTop.value;
  window.addEventListener('pointermove', onDragPointerMove);
  window.addEventListener('pointerup', stopDrag, { once: true });
  window.addEventListener('pointercancel', stopDrag, { once: true });
}

function onDragPointerMove(event: PointerEvent): void {
  if (!dragging.value) return;
  event.preventDefault();
  updateHoverFromPointer(event);
  const deltaY = (isHorizontal.value ? event.clientX : event.clientY) - dragStartY;
  const nextScrollTop = dragStartScrollTop + (deltaY / trackTravel.value) * maxScroll.value;
  setScrollTop(nextScrollTop);
}

function stopDrag(event?: PointerEvent): void {
  const shouldClosePanel = event ? !isPointerInsideInteractiveArea(event) : panelOpen.value;
  dragging.value = false;
  window.removeEventListener('pointermove', onDragPointerMove);
  window.removeEventListener('pointerup', stopDrag);
  window.removeEventListener('pointercancel', stopDrag);
  scheduleSync();
  if (shouldClosePanel) scheduleClosePanel();
}

function activateTrackMarker(marker: MarkerView): void {
  activeMarkerId.value = marker.id;
  hoverTrackY.value = marker.top;
}

function activatePanelMarker(marker: MarkerView): void {
  activeMarkerId.value = marker.id;
}

function detachScroller(): void {
  if (observedScroller) observedScroller.removeEventListener('scroll', scheduleSync);
  observedScroller = null;
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  mutationObserver?.disconnect();
  mutationObserver = undefined;
}

function attachScroller(element: HTMLElement | null): void {
  detachScroller();
  if (!element) return;

  observedScroller = element;
  element.addEventListener('scroll', scheduleSync, { passive: true });

  resizeObserver = new ResizeObserver(scheduleSync);
  resizeObserver.observe(element);
  if (element.firstElementChild instanceof HTMLElement) {
    resizeObserver.observe(element.firstElementChild);
  }

  mutationObserver = new MutationObserver(scheduleSync);
  mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });

  void nextTick(scheduleSync);
}

watch(() => props.scroller, attachScroller, { immediate: true, flush: 'post' });
watch(() => props.refreshKey, () => void nextTick(scheduleSync), { flush: 'post' });
watch(
  () => props.markers.map((marker) => `${marker.id}:${marker.label}:${marker.preview}:${marker.kind ?? ''}`).join('\n'),
  () => void nextTick(scheduleSync),
  { flush: 'post' }
);

onBeforeUnmount(() => {
  detachScroller();
  stopDrag();
  cancelClosePanel();
  if (animationFrame) window.cancelAnimationFrame(animationFrame);
});
</script>

<template>
  <div
    ref="scrollbarRootRef"
    class="advanced-scrollbar"
    :class="{
      'is-hidden': !canScroll,
      'is-dragging': dragging,
      'is-expanded': panelOpen,
      'has-edge-buttons': showEdgeButtons,
      'has-markers': showMarkers,
      'is-minimal': variant === 'minimal',
      'is-horizontal': isHorizontal
    }"
    aria-hidden="false"
    @pointerenter="openPanel"
    @pointerleave="scheduleClosePanel"
  >
    <button
      v-if="showEdgeButtons"
      type="button"
      class="edge-button"
      :disabled="!canScroll || atTop"
      title="回到顶部"
      aria-label="回到顶部"
      @click="scrollToTop"
    >
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 7.5 6 3.5l4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" />
      </svg>
    </button>

    <div
      ref="trackRef"
      class="scroll-track"
      role="scrollbar"
      :aria-orientation="isHorizontal ? 'horizontal' : 'vertical'"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(maxScroll)"
      :aria-valuenow="Math.round(scrollTop)"
      @pointermove="onTrackPointerMove"
      @pointerdown="onTrackPointerDown"
    >
      <template v-if="showMarkers && !isHorizontal">
        <button
          v-for="marker in markerViews"
          :key="marker.id"
          type="button"
          class="scroll-marker"
          :class="[marker.kind, { 'is-active': activeMarkerId === marker.id }]"
          :style="{ top: `${marker.top}px` }"
          :title="marker.label"
          :aria-label="`跳转到${marker.label}`"
          @click.stop="scrollToMarker(marker)"
          @mouseenter="activateTrackMarker(marker)"
          @focus="activateTrackMarker(marker)"
        />
      </template>

      <div
        class="scroll-thumb"
        :style="thumbStyle"
        role="presentation"
        @pointerdown.stop="onThumbPointerDown"
      />
    </div>

    <section
      ref="markerPanelRef"
      v-if="panelOpen && visiblePanelMarkers.length"
      class="marker-panel"
      :style="markerPanelStyle"
      @pointerenter="openPanel"
    >
      <div class="marker-panel-title">附近节点</div>
      <button
        v-for="marker in visiblePanelMarkers"
        :key="marker.id"
        type="button"
        class="zoom-marker"
        :class="[marker.kind, { 'is-active': activeMarkerId === marker.id }]"
        @click="scrollToMarker(marker)"
        @mouseenter="activatePanelMarker(marker)"
        @focus="activatePanelMarker(marker)"
      >
        <span class="zoom-marker-line" aria-hidden="true"></span>
        <span class="zoom-marker-text">
          <span class="zoom-marker-label">{{ marker.label }}</span>
          <span v-if="showMarkerPreview && marker.preview" class="zoom-marker-preview">{{ marker.preview }}</span>
        </span>
      </button>
    </section>

    <button
      v-if="showEdgeButtons"
      type="button"
      class="edge-button"
      :disabled="!canScroll || atBottom"
      title="回到底部"
      aria-label="回到底部"
      @click="scrollToBottom"
    >
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 4.5 6 8.5l4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.advanced-scrollbar {
  position: absolute;
  top: 8px;
  right: 5px;
  bottom: 8px;
  width: 18px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 4px;
  opacity: 0.82;
  transition: opacity 0.16s ease;
  user-select: none;
}

.advanced-scrollbar.is-hidden {
  opacity: 0;
  pointer-events: none;
}

.advanced-scrollbar:hover,
.advanced-scrollbar.is-dragging,
.advanced-scrollbar.is-expanded {
  opacity: 1;
}

.advanced-scrollbar.is-expanded::before {
  content: '';
  position: absolute;
  top: 0;
  right: 100%;
  bottom: 0;
  width: 12px;
  background: transparent;
  pointer-events: auto;
}

.edge-button {
  width: 18px;
  height: 18px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  cursor: pointer;
}

.edge-button:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground) 18%));
}

.edge-button:disabled {
  opacity: 0.35;
  cursor: default;
}

.scroll-track {
  position: relative;
  flex: 1 1 auto;
  min-height: 40px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  border-radius: 0;
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
  cursor: pointer;
}

.scroll-thumb {
  position: absolute;
  top: 0;
  left: 2px;
  right: 2px;
  min-height: 32px;
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 40%, transparent);
  border-radius: 0;
  background: color-mix(in srgb, var(--vscode-foreground) 42%, var(--vscode-editor-background) 58%);
  cursor: grab;
  will-change: transform, height;
}

.scroll-thumb:hover,
.advanced-scrollbar.is-dragging .scroll-thumb {
  background: color-mix(in srgb, var(--vscode-foreground) 58%, var(--vscode-editor-background) 42%);
}

.advanced-scrollbar.is-dragging .scroll-thumb {
  cursor: grabbing;
}

.scroll-marker {
  position: absolute;
  left: -4px;
  right: -4px;
  height: 2px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: var(--vscode-focusBorder, var(--vscode-foreground));
  cursor: pointer;
  opacity: 0.58;
  transform: translateY(-1px);
  transition: height 0.12s ease, opacity 0.12s ease, background 0.12s ease;
}

.advanced-scrollbar.is-minimal {
  top: 4px;
  right: 2px;
  bottom: 4px;
  width: 8px;
  opacity: 0.72;
}

.advanced-scrollbar.is-minimal:hover,
.advanced-scrollbar.is-minimal.is-dragging {
  opacity: 1;
}

.advanced-scrollbar.is-minimal .scroll-track {
  border: 0;
  border-radius: 0;
  background: transparent;
}

.advanced-scrollbar.is-minimal .scroll-thumb {
  left: 2px;
  right: 2px;
  border: 0;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
}

.advanced-scrollbar.is-minimal .scroll-thumb:hover,
.advanced-scrollbar.is-minimal.is-dragging .scroll-thumb {
  background: color-mix(in srgb, var(--vscode-foreground) 68%, transparent);
}

.advanced-scrollbar.is-horizontal {
  top: auto;
  right: 4px;
  bottom: 2px;
  left: 4px;
  width: auto;
  height: 8px;
  flex-direction: row;
}

.advanced-scrollbar.is-horizontal .scroll-track {
  min-width: 40px;
  min-height: 0;
}

.advanced-scrollbar.is-horizontal .scroll-thumb {
  top: 2px;
  bottom: 2px;
  left: 0;
  right: auto;
  min-width: 32px;
  min-height: 0;
  height: auto;
  will-change: transform, width;
}

.advanced-scrollbar.is-horizontal.is-minimal {
  right: 2px;
  bottom: 0;
  left: 2px;
  width: auto;
  height: 6px;
}

.advanced-scrollbar.is-horizontal.is-minimal .scroll-thumb {
  top: 1px;
  bottom: 1px;
  left: 0;
  right: auto;
}

.advanced-scrollbar.is-minimal.is-hidden {
  opacity: 0;
  pointer-events: none;
}

.scroll-marker.user {
  background: var(--vscode-testing-iconPassed, #4caf50);
}

.scroll-marker.model,
.scroll-marker.assistant {
  background: var(--vscode-editorWarning-foreground, #cca700);
}

.scroll-marker.editing {
  height: 5px;
  opacity: 1;
  background: var(--vscode-editorWarning-foreground, #cca700);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 45%, transparent);
  z-index: 2;
}

.scroll-marker:hover,
.scroll-marker:focus-visible,
.scroll-marker.is-active {
  height: 4px;
  opacity: 1;
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.marker-panel {
  position: absolute;
  right: calc(100% + 10px);
  width: min(180px, calc(100vw - 62px));
  max-height: 260px;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-radius: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.26);
  transform: translateY(-50%);
  overflow: hidden;
  scrollbar-width: none;
}

.marker-panel::-webkit-scrollbar {
  display: none;
}

.marker-panel-title {
  padding: 0 2px 4px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.3;
  flex: 0 0 auto;
}

.zoom-marker {
  width: 100%;
  min-height: 40px;
  flex: 0 0 auto;
  padding: 4px 5px;
  border: 1px solid transparent;
  border-radius: 0;
  display: grid;
  grid-template-columns: 4px minmax(0, 1fr);
  gap: 8px;
  align-items: stretch;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  overflow: hidden;
}

.zoom-marker:hover,
.zoom-marker:focus-visible,
.zoom-marker.is-active {
  border-color: transparent;
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground) 18%));
  outline: none;
}

.zoom-marker-line {
  width: 4px;
  min-height: 100%;
  height: auto;
  align-self: stretch;
  margin: 0;
  background: var(--vscode-focusBorder, var(--vscode-foreground));
}

.zoom-marker.user .zoom-marker-line {
  background: var(--vscode-testing-iconPassed, #4caf50);
}

.zoom-marker.model .zoom-marker-line,
.zoom-marker.assistant .zoom-marker-line {
  background: var(--vscode-editorWarning-foreground, #cca700);
}

.zoom-marker.editing {
  box-shadow: inset 0 0 0 1px var(--vscode-editorWarning-foreground, #cca700);
}

.zoom-marker.editing .zoom-marker-line {
  background: var(--vscode-editorWarning-foreground, #cca700);
}

.zoom-marker-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-self: stretch;
  overflow: hidden;
}

.zoom-marker-label {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.25;
}

.zoom-marker-preview {
  display: block;
  overflow: hidden;
  width: 100%;
  box-sizing: border-box;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  line-height: 1.35;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
