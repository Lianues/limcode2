<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import {
  buildTokenUsageMessages,
  formatCompactTokenNumber,
  formatFloorNumber,
  formatTokenNumber,
  type TokenUsageMessageEntry
} from './tokenUsageModel';

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

type TokenBarSegmentKind = 'system' | 'input' | 'tool' | 'output' | 'reasoning' | 'other';

interface TokenBarSegment {
  key: TokenBarSegmentKind;
  value: number;
  style: Record<string, string>;
}

const clientState = useClientStateStore();
const root = ref<HTMLElement | null>(null);
const expanded = ref(false);
const chartScroller = ref<HTMLElement | null>(null);
const horizontalTrack = ref<HTMLElement | null>(null);
const scrollLeft = ref(0);
const scrollWidth = ref(0);
const clientWidth = ref(0);
const trackWidth = ref(0);
const dragging = ref(false);

let observedScroller: HTMLElement | null = null;
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let animationFrame = 0;
let dragStartX = 0;
let dragStartScrollLeft = 0;

const usageItems = computed(() => buildTokenUsageMessages(clientState.currentMessages));
const latestUsage = computed(() => usageItems.value[usageItems.value.length - 1]);
const hasUsage = computed(() => usageItems.value.length > 0);
const refreshKey = computed(() => usageItems.value.map((item) => `${item.id}:${item.total}:${item.ratio}`).join('|'));
const summaryPercent = computed(() => latestUsage.value ? latestUsage.value.ratio * 100 : 0);
const summaryPercentText = computed(() => `${summaryPercent.value.toFixed(1)}%`);
const summaryTitle = computed(() => latestUsage.value ? messageTitle(latestUsage.value) : '当前对话暂未收到 token usage 数据');
const summaryFillStyle = computed(() => ({ width: usageBarWidth(latestUsage.value?.ratio ?? 0, hasUsage.value) }));
const maxScrollLeft = computed(() => Math.max(0, scrollWidth.value - clientWidth.value));
const canScrollX = computed(() => maxScrollLeft.value > 1);
const horizontalThumbWidth = computed(() => {
  if (!trackWidth.value || !scrollWidth.value) return 0;
  const rawWidth = (clientWidth.value / scrollWidth.value) * trackWidth.value;
  return Math.min(trackWidth.value, Math.max(28, rawWidth));
});
const horizontalTrackTravel = computed(() => Math.max(1, trackWidth.value - horizontalThumbWidth.value));
const horizontalThumbLeft = computed(() => {
  if (!canScrollX.value) return 0;
  return (scrollLeft.value / maxScrollLeft.value) * horizontalTrackTravel.value;
});
const horizontalThumbStyle = computed(() => ({
  width: `${horizontalThumbWidth.value}px`,
  transform: `translateX(${horizontalThumbLeft.value}px)`
}));

watch(() => clientState.currentConversationId, () => {
  expanded.value = false;
});

watch(() => expanded.value, (value) => {
  if (value) void nextTick(scrollChartToEnd);
});

watch(() => refreshKey.value, () => void nextTick(scheduleScrollSync));
watch(() => chartScroller.value, attachScroller, { immediate: true, flush: 'post' });
watch(() => horizontalTrack.value, () => void nextTick(scheduleScrollSync), { flush: 'post' });
watch(() => canScrollX.value, () => void nextTick(scheduleScrollSync), { flush: 'post' });

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onDocumentKeydown);
  detachScroller();
  stopHorizontalDrag();
  if (animationFrame) window.cancelAnimationFrame(animationFrame);
});

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}

function onDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!root.value?.contains(target)) expanded.value = false;
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') expanded.value = false;
}

function messageBarStyle(item: TokenUsageMessageEntry): Record<string, string> {
  return { height: usageBarHeight(item.ratio, item.total > 0) };
}

function usageBarWidth(ratio: number, hasValue: boolean): string {
  if (!hasValue) return '0%';
  const clamped = Math.max(0, Math.min(1, ratio));
  if (clamped <= 0) return '0%';
  return `${Math.max(4, clamped * 100)}%`;
}

function usageBarHeight(ratio: number, hasValue: boolean): string {
  if (!hasValue) return '0%';
  const clamped = Math.max(0, Math.min(1, ratio));
  if (clamped <= 0) return '0%';
  return `${Math.max(5, clamped * 100)}%`;
}

function tokenText(item: TokenUsageMessageEntry): string {
  return `${item.totalEstimated ? '≈' : ''}${formatTokenNumber(item.total)}`;
}

function compactTokenText(item: TokenUsageMessageEntry): string {
  return `${item.totalEstimated ? '≈' : ''}${formatCompactTokenNumber(item.total)}`;
}

function messageTitle(item: TokenUsageMessageEntry): string {
  if (item.kind === 'system') {
    return [`楼层 0`, `类型：系统提示词`, `token：${tokenText(item)}`].join('\n');
  }

  return [
    `第 ${item.index} 楼`,
    `角色：${roleLabel(item.role)}`,
    `消息 seq：${item.messageSeq}`,
    `${messageTokenLabel(item)}：${tokenText(item)}`,
    ...optionalTokenRows(item),
    `状态：${statusLabel(item.status)}`
  ].join('\n');
}

function messageTooltipTitle(item: TokenUsageMessageEntry): string {
  if (item.kind === 'system') return '楼层 0 系统提示词 token';
  return `第 ${item.index} 楼消息 token`;
}

function messageTooltipRows(item: TokenUsageMessageEntry): TooltipPanelItem[] {
  if (item.kind === 'system') {
    return [
      { label: '楼层', value: '#00' },
      { label: '类型', value: '系统提示词' },
      { label: 'token', value: tokenText(item) },
      { label: '高度', value: '固定 100%' }
    ];
  }

  const rows: TooltipPanelItem[] = [
    { label: '楼层', value: `#${formatFloorNumber(item.index)}` },
    { label: '角色', value: roleLabel(item.role) },
    { label: '消息 seq', value: String(item.messageSeq) },
    { label: messageTokenLabel(item), value: tokenText(item) },
    { label: '相对峰值', value: `${(item.ratio * 100).toFixed(1)}%` }
  ];

  const detailRows = tokenDetailTooltipRows(item);
  if (detailRows.length > 0) {
    rows.push({ kind: 'divider', id: `${item.id}-details` });
    rows.push(...detailRows);
  }

  rows.push({ kind: 'divider', id: `${item.id}-status` });
  rows.push({ label: '状态', value: statusLabel(item.status) });
  return rows;
}

function tokenDetailTooltipRows(item: TokenUsageMessageEntry): TooltipPanelRow[] {
  return [
    tokenTooltipRow('思考 token', item.reasoning),
    tokenTooltipRow('输出 token', item.output),
    tokenTooltipRow('工具 token', item.tool),
    tokenTooltipRow('输入 token', item.input)
  ].filter((row): row is TooltipPanelRow => row !== undefined);
}

function tokenTooltipRow(label: string, value: number | undefined): TooltipPanelRow | undefined {
  return value !== undefined ? { label, value: formatTokenNumber(value) } : undefined;
}

function optionalTokenRows(item: TokenUsageMessageEntry): string[] {
  return [
    tokenRow('思考', item.reasoning),
    tokenRow('输出', item.output),
    tokenRow('工具', item.tool),
    tokenRow('输入', item.input)
  ].filter((row): row is string => row !== undefined);
}

function tokenRow(label: string, value: number | undefined): string | undefined {
  return value !== undefined ? `${label} token：${formatTokenNumber(value)}` : undefined;
}

function messageBarSegments(item: TokenUsageMessageEntry): TokenBarSegment[] {
  if (item.kind === 'system') return [tokenBarSegment('system', item.total, item.total)].filter((segment): segment is TokenBarSegment => segment !== undefined);
  if (item.role === 'user') return [tokenBarSegment('input', item.input ?? item.total, item.total)].filter((segment): segment is TokenBarSegment => segment !== undefined);
  const tool = item.tool ?? 0;
  const output = item.output ?? 0;
  const reasoning = item.reasoning ?? 0;
  const outputBody = Math.max(0, output - reasoning);
  const categorizedTotal = tool + outputBody + reasoning;
  const other = Math.max(0, item.total - categorizedTotal);
  const basis = Math.max(item.total, categorizedTotal);

  if (basis <= 0) return [];

  return [
    tokenBarSegment('tool', tool, basis),
    tokenBarSegment('output', outputBody, basis),
    tokenBarSegment('reasoning', reasoning, basis),
    tokenBarSegment('other', other, basis)
  ].filter((segment): segment is TokenBarSegment => segment !== undefined);
}

function messageTokenLabel(item: TokenUsageMessageEntry): string {
  return item.role === 'user' ? '输入 token' : '非输入 token';
}

function tokenBarSegment(kind: TokenBarSegmentKind, value: number, basis: number): TokenBarSegment | undefined {
  if (value <= 0 || basis <= 0) return undefined;
  return {
    key: kind,
    value,
    style: { height: `${(value / basis) * 100}%` }
  };
}

function roleLabel(role: TokenUsageMessageEntry['role']): string {
  if (!role) return '未知';
  return role === 'user' ? '用户消息' : 'AI 消息';
}

function statusLabel(status: TokenUsageMessageEntry['status']): string {
  if (!status) return '未知';
  switch (status) {
    case 'streaming':
      return '流式输出中';
    case 'complete':
      return '完成';
    case 'error':
      return '错误';
  }
}

function syncScrollMetrics(): void {
  animationFrame = 0;
  const scroller = chartScroller.value;
  if (!scroller) return;
  scrollLeft.value = scroller.scrollLeft;
  scrollWidth.value = scroller.scrollWidth;
  clientWidth.value = scroller.clientWidth;
  trackWidth.value = horizontalTrack.value?.clientWidth ?? 0;
}

function scrollChartToEnd(): void {
  const scroller = chartScroller.value;
  if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  scheduleScrollSync();
}

function scheduleScrollSync(): void {
  if (animationFrame) return;
  animationFrame = window.requestAnimationFrame(syncScrollMetrics);
}

function attachScroller(element: HTMLElement | null): void {
  detachScroller();
  if (!element) return;

  observedScroller = element;
  element.addEventListener('scroll', scheduleScrollSync, { passive: true });

  resizeObserver = new ResizeObserver(scheduleScrollSync);
  resizeObserver.observe(element);
  if (element.firstElementChild instanceof HTMLElement) resizeObserver.observe(element.firstElementChild);
  if (horizontalTrack.value) resizeObserver.observe(horizontalTrack.value);

  mutationObserver = new MutationObserver(scheduleScrollSync);
  mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });

  void nextTick(scheduleScrollSync);
}

function detachScroller(): void {
  if (observedScroller) observedScroller.removeEventListener('scroll', scheduleScrollSync);
  observedScroller = null;
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  mutationObserver?.disconnect();
  mutationObserver = undefined;
}

function setScrollLeft(value: number, behavior: ScrollBehavior = 'auto'): void {
  const scroller = chartScroller.value;
  if (!scroller) return;
  scroller.scrollTo({ left: clamp(value, 0, maxScrollLeft.value), behavior });
}

function onChartWheel(event: WheelEvent): void {
  if (!canScrollX.value || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  event.preventDefault();
  setScrollLeft(scrollLeft.value + event.deltaY);
}

function onHorizontalTrackPointerDown(event: PointerEvent): void {
  if (!canScrollX.value || event.target !== horizontalTrack.value) return;
  const track = horizontalTrack.value;
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const x = event.clientX - rect.left - horizontalThumbWidth.value / 2;
  const nextScrollLeft = (clamp(x, 0, horizontalTrackTravel.value) / horizontalTrackTravel.value) * maxScrollLeft.value;
  setScrollLeft(nextScrollLeft, 'smooth');
}

function onHorizontalThumbPointerDown(event: PointerEvent): void {
  if (!canScrollX.value) return;
  event.preventDefault();
  dragging.value = true;
  dragStartX = event.clientX;
  dragStartScrollLeft = scrollLeft.value;
  window.addEventListener('pointermove', onHorizontalDragPointerMove);
  window.addEventListener('pointerup', stopHorizontalDrag, { once: true });
  window.addEventListener('pointercancel', stopHorizontalDrag, { once: true });
}

function onHorizontalDragPointerMove(event: PointerEvent): void {
  if (!dragging.value) return;
  event.preventDefault();
  const deltaX = event.clientX - dragStartX;
  const nextScrollLeft = dragStartScrollLeft + (deltaX / horizontalTrackTravel.value) * maxScrollLeft.value;
  setScrollLeft(nextScrollLeft);
}

function stopHorizontalDrag(): void {
  dragging.value = false;
  window.removeEventListener('pointermove', onHorizontalDragPointerMove);
  window.removeEventListener('pointerup', stopHorizontalDrag);
  window.removeEventListener('pointercancel', stopHorizontalDrag);
  scheduleScrollSync();
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}
</script>

<template>
  <span ref="root" class="context-token-usage-panel" :class="{ 'is-expanded': expanded, 'is-empty': !hasUsage }">
    <button
      type="button"
      class="context-token-summary"
      :aria-expanded="expanded"
      :aria-label="`展开或收起 token 用量面板，${summaryTitle}`"
      @click="toggleExpanded"
    >
      <span class="context-token-summary-track" role="img" :aria-label="summaryTitle">
        <span class="context-token-summary-fill" :style="summaryFillStyle" aria-hidden="true"></span>
      </span>
      <span class="context-token-summary-percent">{{ summaryPercentText }}</span>
    </button>

    <Transition name="lc-dropdown">
      <section v-if="expanded" class="context-token-dropdown lc-dropdown-panel" role="dialog" aria-label="每条消息 token 用量" @click.stop>
        <div v-if="hasUsage" class="context-token-chart-shell">
          <div ref="chartScroller" class="context-token-chart-scroll" @wheel="onChartWheel">
            <div class="context-token-chart-list">
              <HoverTooltipPanel
                v-for="item in usageItems"
                :key="item.id"
                class="context-token-message-tooltip"
                :panel-title="messageTooltipTitle(item)"
                :rows="messageTooltipRows(item)"
                :aria-label="messageTitle(item)"
                tabindex="0"
              >
                <div class="context-token-message-column" :class="{ 'is-system': item.kind === 'system', 'is-estimated': item.totalEstimated || item.sourceEstimated }">
                  <span class="context-token-message-value">{{ compactTokenText(item) }}</span>
                  <div class="context-token-message-bar-slot" aria-hidden="true">
                    <div class="context-token-message-bar" :style="messageBarStyle(item)">
                      <span
                        v-for="segment in messageBarSegments(item)"
                        :key="segment.key"
                        class="context-token-message-bar-segment"
                        :class="`is-${segment.key}`"
                        :style="segment.style"
                      ></span>
                    </div>
                  </div>
                  <span class="context-token-message-role-marker" :class="{ 'is-user': item.role === 'user' }" aria-hidden="true">
                    {{ item.role === 'user' ? '◆' : '' }}
                  </span>
                  <span class="context-token-message-index">{{ formatFloorNumber(item.index) }}</span>
                </div>
              </HoverTooltipPanel>
            </div>
          </div>
          <div
            v-if="canScrollX"
            class="context-token-horizontal-scrollbar"
            :class="{ 'is-dragging': dragging }"
            aria-hidden="true"
          >
            <div ref="horizontalTrack" class="context-token-horizontal-track" @pointerdown="onHorizontalTrackPointerDown">
              <div
                class="context-token-horizontal-thumb"
                :style="horizontalThumbStyle"
                @pointerdown.stop="onHorizontalThumbPointerDown"
              ></div>
            </div>
          </div>
        </div>
        <div v-else class="context-token-empty">暂无 token usage</div>
      </section>
    </Transition>
  </span>
</template>

<style scoped>
.context-token-usage-panel {
  position: relative;
  flex: 0 0 auto;
  width: 112px;
  min-width: 96px;
  display: inline-flex;
  justify-content: flex-end;
  --lc-dropdown-transform-origin: bottom right;
  --lc-dropdown-offset-y: 4px;
}

.context-token-summary {
  width: 100%;
  min-width: 0;
  min-height: 20px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 0 4px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  text-align: right;
  cursor: pointer;
  appearance: none;
  -webkit-tap-highlight-color: transparent;
}

.context-token-summary:hover:not(:disabled),
.context-token-summary:focus,
.context-token-summary:focus-visible,
.context-token-summary:active {
  color: var(--vscode-foreground);
  background: transparent;
  box-shadow: none;
  outline: none;
}

.context-token-summary:hover:not(:disabled),
.context-token-summary:focus-visible,
.context-token-summary:active {
  border-color: transparent;
  background: transparent;
}

.context-token-summary:hover:not(:disabled) .context-token-summary-track,
.context-token-summary:focus-visible .context-token-summary-track,
.context-token-summary:active .context-token-summary-track {
  border-color: color-mix(in srgb, var(--vscode-panel-border) 55%, var(--vscode-foreground) 45%);
  background: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-foreground) 16%);
}

.context-token-summary:hover:not(:disabled) .context-token-summary-fill,
.context-token-summary:focus-visible .context-token-summary-fill,
.context-token-summary:active .context-token-summary-fill {
  background: color-mix(in srgb, var(--vscode-foreground) 34%, transparent);
}

.context-token-summary[aria-expanded='true'] {
  color: var(--vscode-foreground);
}

.context-token-summary:focus-visible .context-token-summary-track {
  border-color: color-mix(in srgb, var(--vscode-panel-border) 45%, var(--vscode-foreground) 55%);
}

.context-token-summary-track {
  position: relative;
  flex: 0 0 58px;
  width: 58px;
  height: 7px;
  overflow: hidden;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}

.context-token-summary-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: color-mix(in srgb, var(--vscode-foreground) 24%, transparent);
}

.context-token-summary-percent {
  flex: 0 0 42px;
  overflow: hidden;
  color: currentColor;
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  line-height: 1;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-token-dropdown {
  position: absolute;
  right: 0;
  top: auto;
  bottom: calc(100% + 5px);
  z-index: 35;
  width: min(360px, calc(100vw - 24px));
  height: 156px;
  padding: 9px 10px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-editor-background);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22);
}

.context-token-chart-shell {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.context-token-chart-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.context-token-chart-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.context-token-chart-list {
  width: max-content;
  min-width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 2px 2px 0;
}

.context-token-message-tooltip {
  flex: 0 0 34px;
  height: 100%;
  display: inline-flex;
  align-items: stretch;
  justify-content: center;
  outline: none;
}

.context-token-message-column {
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-rows: 14px minmax(0, 1fr) 8px 14px;
  align-items: stretch;
  justify-items: center;
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
}

.context-token-message-column:hover,
.context-token-message-tooltip:focus-visible .context-token-message-column {
  color: var(--vscode-foreground);
}

.context-token-message-value,
.context-token-message-role-marker,
.context-token-message-index {
  width: 100%;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  line-height: 14px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-token-message-value {
  color: var(--vscode-foreground);
}

.context-token-message-role-marker {
  height: 8px;
  color: transparent;
  font-size: 7px;
  line-height: 8px;
}

.context-token-message-role-marker.is-user {
  color: color-mix(in srgb, var(--vscode-foreground) 68%, transparent);
}

.context-token-message-bar-slot {
  position: relative;
  width: 20px;
  height: 100%;
  min-height: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  border-inline: 1px solid color-mix(in srgb, var(--vscode-panel-border) 38%, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.context-token-message-bar {
  width: 100%;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column-reverse;
  background: transparent;
  transition: height 0.16s ease;
}

.context-token-message-bar-segment {
  flex: 0 0 auto;
  width: 100%;
  min-height: 0;
}

.context-token-message-bar-segment.is-system {
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 36%, transparent);
}

.context-token-message-bar-segment.is-input {
  background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
}

.context-token-message-bar-segment.is-cached {
  background: color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
}

.context-token-message-bar-segment.is-tool {
  background: color-mix(in srgb, var(--vscode-foreground) 30%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-foreground) 18%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--vscode-editor-background) 50%, transparent);
}

.context-token-message-bar-segment.is-output {
  background: color-mix(in srgb, var(--vscode-foreground) 52%, transparent);
}

.context-token-message-bar-segment.is-reasoning {
  background: repeating-linear-gradient(
    45deg,
    color-mix(in srgb, var(--vscode-foreground) 62%, transparent) 0,
    color-mix(in srgb, var(--vscode-foreground) 62%, transparent) 3px,
    color-mix(in srgb, var(--vscode-foreground) 28%, transparent) 3px,
    color-mix(in srgb, var(--vscode-foreground) 28%, transparent) 6px
  );
}

.context-token-message-bar-segment.is-other {
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 24%, transparent);
}

.context-token-message-column:hover .context-token-message-bar,
.context-token-message-tooltip:focus-visible .context-token-message-bar {
  filter: brightness(1.22);
}

.context-token-message-column.is-estimated .context-token-message-bar,
.context-token-message-column.is-system .context-token-message-bar {
  background-image: repeating-linear-gradient(
    45deg,
    color-mix(in srgb, var(--vscode-foreground) 22%, transparent) 0,
    color-mix(in srgb, var(--vscode-foreground) 22%, transparent) 3px,
    transparent 3px,
    transparent 6px
  );
}

.context-token-horizontal-scrollbar {
  flex: 0 0 auto;
  height: 10px;
  padding: 4px 0 0;
  opacity: 0.72;
  transition: opacity 0.16s ease;
}

.context-token-horizontal-scrollbar:hover,
.context-token-horizontal-scrollbar.is-dragging {
  opacity: 1;
}

.context-token-horizontal-track {
  position: relative;
  height: 4px;
  overflow: hidden;
  background: transparent;
  cursor: pointer;
}

.context-token-horizontal-thumb {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  min-width: 28px;
  background: color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
  cursor: grab;
}

.context-token-horizontal-thumb:hover,
.context-token-horizontal-scrollbar.is-dragging .context-token-horizontal-thumb {
  background: color-mix(in srgb, var(--vscode-foreground) 40%, transparent);
}

.context-token-horizontal-scrollbar.is-dragging .context-token-horizontal-thumb {
  cursor: grabbing;
}

.context-token-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  text-align: center;
}

.context-token-usage-panel.is-empty .context-token-summary-fill {
  width: 0;
}
</style>
