<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';

interface TooltipPanelRow {
  kind?: 'row';
  label: string;
  value: string;
  nested?: boolean;
}

interface TooltipPanelDivider {
  kind: 'divider';
  id?: string;
}

type TooltipPanelItem = TooltipPanelRow | TooltipPanelDivider;

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    panelTitle: string;
    rows: TooltipPanelItem[];
    delayMs?: number;
  }>(),
  { delayMs: 320 }
);

const open = ref(false);
const placement = ref<'top' | 'bottom'>('top');
const panelStyle = ref<Record<string, string>>(initialPanelStyle());
const triggerRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

let showTimer: number | undefined;
let hideTimer: number | undefined;
let positionFrame: number | undefined;
let positionListenersAttached = false;

onBeforeUnmount(() => {
  cancelShowTimer();
  cancelHideTimer();
  if (positionFrame !== undefined) window.cancelAnimationFrame(positionFrame);
  detachPositionListeners();
});

function scheduleOpen(): void {
  cancelHideTimer();
  cancelShowTimer();
  showTimer = window.setTimeout(() => {
    showTimer = undefined;
    openNow();
  }, props.delayMs);
}

function openNow(): void {
  cancelShowTimer();
  cancelHideTimer();
  open.value = true;
  panelStyle.value = initialPanelStyle();
  attachPositionListeners();
  void nextTick(() => updatePosition());
}

function scheduleClose(): void {
  cancelShowTimer();
  cancelHideTimer();
  hideTimer = window.setTimeout(() => {
    hideTimer = undefined;
    closeNow();
  }, 120);
}

function closeNow(): void {
  cancelShowTimer();
  open.value = false;
  panelStyle.value = initialPanelStyle();
  detachPositionListeners();
}

function cancelShowTimer(): void {
  if (showTimer === undefined) return;
  window.clearTimeout(showTimer);
  showTimer = undefined;
}

function cancelHideTimer(): void {
  if (hideTimer === undefined) return;
  window.clearTimeout(hideTimer);
  hideTimer = undefined;
}

function schedulePosition(): void {
  if (positionFrame !== undefined) return;
  positionFrame = window.requestAnimationFrame(() => {
    positionFrame = undefined;
    updatePosition();
  });
}

function updatePosition(): void {
  const trigger = triggerRef.value;
  const panel = panelRef.value;
  if (!open.value || !trigger || !panel) return;

  const margin = 8;
  const gap = 8;
  const viewport = viewportSize();
  const maxWidth = Math.max(160, viewport.width - margin * 2);
  const triggerRect = trigger.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const panelWidth = Math.min(panelRect.width, maxWidth);
  const panelHeight = panelRect.height;

  const topWhenAbove = triggerRect.top - gap - panelHeight;
  const topWhenBelow = triggerRect.bottom + gap;
  const fitsAbove = topWhenAbove >= margin;
  const fitsBelow = topWhenBelow + panelHeight <= viewport.height - margin;
  const spaceAbove = triggerRect.top - margin - gap;
  const spaceBelow = viewport.height - triggerRect.bottom - margin - gap;
  const placeTop = !fitsBelow && (fitsAbove || spaceAbove >= spaceBelow);
  const rawTop = placeTop ? topWhenAbove : topWhenBelow;

  const left = clamp(triggerRect.right - panelWidth, margin, viewport.width - panelWidth - margin);
  const top = clamp(rawTop, margin, viewport.height - panelHeight - margin);
  const triggerCenter = triggerRect.left + triggerRect.width / 2;
  const arrowLeft = clamp(triggerCenter - left, 12, panelWidth - 12);

  placement.value = placeTop ? 'top' : 'bottom';
  panelStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    maxWidth: `${Math.round(maxWidth)}px`,
    '--lc-tooltip-arrow-left': `${Math.round(arrowLeft)}px`
  };
}

function attachPositionListeners(): void {
  if (positionListenersAttached) return;
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
  positionListenersAttached = true;
}

function detachPositionListeners(): void {
  if (!positionListenersAttached) return;
  window.removeEventListener('resize', schedulePosition);
  window.removeEventListener('scroll', schedulePosition, true);
  positionListenersAttached = false;
}

function initialPanelStyle(): Record<string, string> {
  const viewportWidth = viewportSize().width;
  return {
    left: '-9999px',
    top: '-9999px',
    maxWidth: `${Math.max(160, viewportWidth - 16)}px`
  };
}

function viewportSize(): { width: number; height: number } {
  return {
    width: document.documentElement.clientWidth || window.innerWidth,
    height: document.documentElement.clientHeight || window.innerHeight
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function isDivider(item: TooltipPanelItem): item is TooltipPanelDivider {
  return item.kind === 'divider';
}

function itemKey(item: TooltipPanelItem, index: number): string {
  return isDivider(item) ? `divider-${item.id ?? index}` : `${item.label}-${index}`;
}
</script>

<template>
  <span
    ref="triggerRef"
    class="lc-hover-tooltip-trigger"
    v-bind="$attrs"
    @mouseenter="scheduleOpen"
    @mouseleave="scheduleClose"
    @focusin="openNow"
    @focusout="scheduleClose"
  >
    <slot />

    <Teleport to="body">
      <Transition name="lc-hover-tooltip">
        <span
          v-if="open"
          ref="panelRef"
          class="lc-hover-tooltip-panel"
          :class="[`is-placement-${placement}`]"
          :style="panelStyle"
          role="tooltip"
          @mouseenter="openNow"
          @mouseleave="scheduleClose"
        >
          <span class="lc-hover-tooltip-title">{{ panelTitle }}</span>
          <template v-for="(item, index) in rows" :key="itemKey(item, index)">
            <span v-if="isDivider(item)" class="lc-hover-tooltip-divider" aria-hidden="true"></span>
            <span v-else class="lc-hover-tooltip-row" :class="{ 'is-nested': item.nested }">
              <span class="lc-hover-tooltip-label">{{ item.label }}</span>
              <span class="lc-hover-tooltip-value">{{ item.value }}</span>
            </span>
          </template>
        </span>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped>
.lc-hover-tooltip-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  vertical-align: middle;
  line-height: inherit;
}

.lc-hover-tooltip-panel {
  position: fixed;
  left: -9999px;
  top: -9999px;
  z-index: 1000;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 190px;
  width: max-content;
  max-width: min(320px, calc(100vw - 28px));
  padding: 8px 10px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
  font-size: var(--font-size-xs);
  line-height: 1.35;
  white-space: normal;
  pointer-events: auto;
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

.lc-hover-tooltip-enter-active,
.lc-hover-tooltip-leave-active {
  transition:
    opacity 120ms ease,
    transform 120ms ease,
    visibility 120ms ease;
}

.lc-hover-tooltip-enter-from,
.lc-hover-tooltip-leave-to {
  opacity: 0;
  visibility: hidden;
  transform: translateY(3px);
}

.lc-hover-tooltip-enter-to,
.lc-hover-tooltip-leave-from {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

.lc-hover-tooltip-panel::after {
  content: '';
  position: absolute;
  left: var(--lc-tooltip-arrow-left, calc(100% - 14px));
  width: 8px;
  height: 8px;
  background: inherit;
  transform: translateX(-50%) rotate(45deg);
}

.lc-hover-tooltip-panel.is-placement-top::after {
  bottom: -5px;
  border-right: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
}

.lc-hover-tooltip-panel.is-placement-bottom::after {
  top: -5px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-left: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
}

.lc-hover-tooltip-title {
  font-weight: 600;
  color: var(--vscode-foreground);
}

.lc-hover-tooltip-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
}

.lc-hover-tooltip-row.is-nested {
  padding-left: 10px;
}

.lc-hover-tooltip-label {
  color: var(--vscode-descriptionForeground);
}

.lc-hover-tooltip-value {
  flex: 0 0 auto;
  color: var(--vscode-foreground);
  font-variant-numeric: tabular-nums;
}

.lc-hover-tooltip-divider {
  height: 1px;
  margin: 2px 0;
  background: var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
}
</style>
