<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, type ComponentPublicInstance } from 'vue';
import {
  IconArrowNarrowDown,
  IconArrowNarrowUp,
  IconCheck,
  IconCopy,
  IconEdit,
  IconEye,
  IconHash,
  IconRefresh,
  IconTrash
} from '@tabler/icons-vue';
import { isVisibleTextPart, type LlmUsageMetadataRecord, type MessageRecord, type MessageStopReason } from '@shared/protocol';
import RichContentView from '@webview/components/content/RichContentView.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';

const props = withDefaults(
  defineProps<{
    message: MessageRecord;
    runId?: string;
    runDetailLoading?: boolean;
    deleteCount?: number;
    deleting?: boolean;
    entering?: boolean;
    editingHighlighted?: boolean;
  }>(),
  { runId: undefined, runDetailLoading: false, deleteCount: 1, deleting: false, entering: false, editingHighlighted: false }
);

const emit = defineEmits<{
  (event: 'edit-message', message: MessageRecord): void;
  (event: 'retry-from', message: MessageRecord): void;
  (event: 'delete-from', message: MessageRecord): void;
  (event: 'view-run-detail', message: MessageRecord): void;
}>();

const roleLabel = computed(() => (props.message.role === 'user' ? '你' : 'AI'));
type TokenUsageKind = 'total' | 'input' | 'output';
interface TokenUsageDetailItem {
  label: string;
  value: string;
  depth?: number;
}
interface TokenUsageItem {
  key: TokenUsageKind;
  label: string;
  value: number;
  compact: string;
  exact: string;
  suffix?: string;
  details: TokenUsageDetailItem[];
}

const hasOwn = Object.prototype.hasOwnProperty;
type TemplateRefElement = Element | ComponentPublicInstance | null;
const streaming = computed(() => props.message.status === 'streaming');
const copied = ref(false);
const activeTokenUsageKey = ref<TokenUsageKind | undefined>();
const tokenUsageTooltipStyle = ref<Record<string, string>>({});
const tokenUsageTooltipPlacement = ref<'top' | 'bottom'>('top');
const confirmRetryOpen = ref(false);
const confirmDeleteOpen = ref(false);
const deleteDescriptionHtml = computed(
  () => `将删除这条消息以及它之后的所有共 ${props.deleteCount} 条消息，此操作<strong>无法撤销</strong>。`
);
const retryDescriptionHtml = computed(
  () => `确定要重试此消息吗？这将删除此消息及后续共 ${props.deleteCount} 条消息，然后重新请求 AI 响应。此操作<strong>不可撤销</strong>。`
);
const messageText = computed(() =>
  props.message.content.parts
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join('')
);

const tokenUsageItems = computed<TokenUsageItem[]>(() => {
  if (props.message.role === 'user') return [];
  const usage = props.message.usageMetadata;
  if (!usage) return [];

  const input = usageNumber(usage, ['promptTokenCount', 'prompt_tokens', 'input_tokens', 'inputTokens']);
  const output = usageNumber(usage, ['candidatesTokenCount', 'completion_tokens', 'output_tokens', 'outputTokens']);
  const total = usageNumber(usage, ['totalTokenCount', 'total_tokens', 'totalTokens']);

  return [
    createTokenUsageItem('total', '总', total, usage),
    createTokenUsageItem('input', '输入', input, usage),
    createTokenUsageItem('output', '输出', output, usage)
  ].filter((item): item is TokenUsageItem => item !== undefined);
});

function createTokenUsageItem(key: TokenUsageKind, label: string, value: number | undefined, usage: LlmUsageMetadataRecord): TokenUsageItem | undefined {
  if (value === undefined) return undefined;
  const exact = formatExactNumber(value);
  const suffix = tokenUsageSuffix(key, usage);
  return {
    key,
    label,
    value,
    compact: formatCompactNumber(value),
    exact,
    ...(suffix ? { suffix } : {}),
    details: tokenUsageDetails(key, usage)
  };
}

let copiedResetTimer: number | undefined;
let tokenUsagePositionFrame: number | undefined;
let tokenUsageHideTimer: number | undefined;
let tokenUsagePositionListenersAttached = false;
const tokenUsageTriggerRefs = new Map<TokenUsageKind, HTMLElement>();
const tokenUsageTooltipRefs = new Map<TokenUsageKind, HTMLElement>();

const deleteConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '删除' }
];
const retryConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '确认' }
];

onBeforeUnmount(() => {
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
  if (tokenUsagePositionFrame !== undefined) window.cancelAnimationFrame(tokenUsagePositionFrame);
  if (tokenUsageHideTimer !== undefined) window.clearTimeout(tokenUsageHideTimer);
  detachTokenUsagePositionListeners();
});

const stopReasonLabel = computed<string | undefined>(() => {
  switch (props.message.stopReason) {
    case 'paused':
      return '已暂停';
    case 'cancelled':
      return '已终止';
    case 'replaced':
      return '已替换';
    case 'stale':
      return '已失效';
    default:
      return undefined;
  }
});

const stopReasonClass = computed<string | undefined>(() => {
  return props.message.stopReason ? `stop-${props.message.stopReason}` : undefined;
});

const stopReasonTitle = computed(() => titleForStopReason(props.message.stopReason));

function titleForStopReason(reason: MessageStopReason | undefined): string | undefined {
  switch (reason) {
    case 'paused':
      return '当前回复已暂停，可稍后恢复继续执行。';
    case 'cancelled':
      return '当前回复已被手动终止。';
    case 'replaced':
      return '当前回复已被新的任务替换。';
    case 'stale':
      return '当前回复已因上下文变化而失效。';
    default:
      return undefined;
  }
}

function usageNumber(usage: LlmUsageMetadataRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    if (!hasOwn.call(usage, key)) continue;
    const value = usage[key];
    const numeric = normalizeTokenNumber(value);
    if (numeric !== undefined) return numeric;
  }
  return undefined;
}

function normalizeTokenNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${formatScaledNumber(value, 1_000_000_000)}b`;
  if (abs >= 1_000_000) return `${formatScaledNumber(value, 1_000_000)}m`;
  if (abs >= 1_000) return `${formatScaledNumber(value, 1_000)}k`;
  return formatExactNumber(value);
}

function formatScaledNumber(value: number, divisor: number): string {
  const scaled = value / divisor;
  const fixed = scaled.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

function formatExactNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function tokenUsageSuffix(key: TokenUsageKind, usage: LlmUsageMetadataRecord): string | undefined {
  if (key === 'input') {
    const cached = usageNumber(usage, ['cachedContentTokenCount', 'cached_content_token_count', 'cached_tokens']);
    return cached !== undefined ? `(${formatCompactNumber(cached)})` : undefined;
  }

  if (key === 'output') {
    const thoughts = usageNumber(usage, ['thoughtsTokenCount', 'reasoning_tokens']);
    return thoughts !== undefined ? `(${formatCompactNumber(thoughts)})` : undefined;
  }

  return undefined;
}

function tokenUsageDetails(key: TokenUsageKind, usage: LlmUsageMetadataRecord): TokenUsageDetailItem[] {
  switch (key) {
    case 'total':
      return usageDetailItems(usage, ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount']);
    case 'input':
      return [
        ...usageDetailItems(usage, ['cachedContentTokenCount', 'cacheCreationInputTokenCount']),
        ...recordUsageDetailItems(usage.cacheCreationInputTokensDetails, 0)
      ];
    case 'output':
      return [
        ...outputBodyTokenDetail(usage),
        ...usageDetailItems(usage, ['thoughtsTokenCount', 'reasoning_tokens'])
      ];
  }
  return [];
}

function usageDetailItems(usage: LlmUsageMetadataRecord, keys: string[]): TokenUsageDetailItem[] {
  const details: TokenUsageDetailItem[] = [];
  for (const key of keys) {
    if (!hasOwn.call(usage, key)) continue;
    const item = detailItemFromValue(key, usage[key], 0);
    if (item) details.push(...item);
  }
  return details;
}

function outputBodyTokenDetail(usage: LlmUsageMetadataRecord): TokenUsageDetailItem[] {
  const output = usageNumber(usage, ['candidatesTokenCount', 'completion_tokens', 'output_tokens', 'outputTokens']);
  const thoughts = usageNumber(usage, ['thoughtsTokenCount', 'reasoning_tokens']);
  if (output === undefined || thoughts === undefined) return [];
  return [{
    label: '正文 token',
    value: formatExactNumber(output - thoughts)
  }];
}

function recordUsageDetailItems(value: unknown, depth: number): TokenUsageDetailItem[] {
  const record = recordValue(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, child]) => detailItemFromValue(key, child, depth) ?? []);
}

function detailItemFromValue(key: string, value: unknown, depth: number): TokenUsageDetailItem[] | undefined {
  const numeric = normalizeTokenNumber(value);
  if (numeric !== undefined) {
    return [{ label: usageLabel(key), value: formatExactNumber(numeric), depth }];
  }

  if (typeof value === 'string' && value.trim()) {
    return [{ label: usageLabel(key), value, depth }];
  }

  const record = recordValue(value);
  if (record) {
    return Object.entries(record).flatMap(([childKey, childValue]) => detailItemFromValue(childKey, childValue, depth + 1) ?? []);
  }

  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function usageLabel(key: string): string {
  const labels: Record<string, string> = {
    promptTokenCount: '输入 token',
    prompt_tokens: '输入 token',
    input_tokens: '输入 token',
    inputTokens: '输入 token',
    cachedContentTokenCount: '缓存命中 token',
    cached_content_token_count: '缓存命中 token',
    cached_tokens: '缓存命中 token',
    cache_read_input_tokens: '缓存读取输入 token',
    cacheCreationInputTokenCount: '缓存创建输入 token',
    cache_creation_input_tokens: '缓存创建输入 token',
    cacheCreationInputTokensDetails: '缓存创建输入明细',
    ephemeral5mInputTokenCount: '5 分钟缓存创建输入 token',
    ephemeral_5m_input_tokens: '5 分钟缓存创建输入 token',
    ephemeral1hInputTokenCount: '1 小时缓存创建输入 token',
    ephemeral_1h_input_tokens: '1 小时缓存创建输入 token',
    candidatesTokenCount: '输出 token',
    completion_tokens: '输出 token',
    output_tokens: '输出 token',
    outputTokens: '输出 token',
    thoughtsTokenCount: '思考 token',
    reasoning_tokens: '推理 token',
    totalTokenCount: '总 token',
    total_tokens: '总 token',
    totalTokens: '总 token'
  };
  return labels[key] ?? humanizeUsageKey(key);
}

function humanizeUsageKey(key: string): string {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean).map((word) => usageWordLabel(word));
  return words.length > 0 ? words.join(' ') : key;
}

function usageWordLabel(word: string): string {
  const labels: Record<string, string> = {
    prompt: '输入',
    input: '输入',
    output: '输出',
    completion: '输出',
    candidate: '候选输出',
    candidates: '输出',
    total: '总',
    token: 'token',
    tokens: 'token',
    cached: '缓存命中',
    cache: '缓存',
    creation: '创建',
    read: '读取',
    reasoning: '推理',
    thoughts: '思考',
    ephemeral: '临时'
  };
  return labels[word] ?? word;
}

function setTokenUsageTriggerRef(key: TokenUsageKind, value: TemplateRefElement): void {
  const element = templateRefHTMLElement(value);
  if (element) {
    tokenUsageTriggerRefs.set(key, element);
    return;
  }
  tokenUsageTriggerRefs.delete(key);
}

function setTokenUsageTooltipRef(key: TokenUsageKind, value: TemplateRefElement): void {
  const element = templateRefHTMLElement(value);
  if (element) {
    tokenUsageTooltipRefs.set(key, element);
    return;
  }
  tokenUsageTooltipRefs.delete(key);
}

function templateRefHTMLElement(value: TemplateRefElement): HTMLElement | undefined {
  if (value instanceof HTMLElement) return value;
  if (value instanceof Element) return undefined;
  const element = value?.$el;
  return element instanceof HTMLElement ? element : undefined;
}

function showTokenUsageTooltip(key: TokenUsageKind): void {
  cancelTokenUsageHideTimer();
  activeTokenUsageKey.value = key;
  tokenUsageTooltipStyle.value = initialTokenUsageTooltipStyle();
  attachTokenUsagePositionListeners();
  void nextTick(() => updateTokenUsageTooltipPosition());
}

function hideTokenUsageTooltip(key: TokenUsageKind): void {
  if (activeTokenUsageKey.value !== key) return;
  cancelTokenUsageHideTimer();
  tokenUsageHideTimer = window.setTimeout(() => {
    tokenUsageHideTimer = undefined;
    if (activeTokenUsageKey.value !== key) return;
    closeTokenUsageTooltip();
  }, 120);
}

function closeTokenUsageTooltip(): void {
  activeTokenUsageKey.value = undefined;
  tokenUsageTooltipStyle.value = {};
  detachTokenUsagePositionListeners();
}

function cancelTokenUsageHideTimer(): void {
  if (tokenUsageHideTimer === undefined) return;
  window.clearTimeout(tokenUsageHideTimer);
  tokenUsageHideTimer = undefined;
}

function initialTokenUsageTooltipStyle(): Record<string, string> {
  const viewportWidth = viewportSize().width;
  return {
    left: '-9999px',
    top: '-9999px',
    maxWidth: `${Math.max(160, viewportWidth - 16)}px`
  };
}

function scheduleTokenUsageTooltipPosition(): void {
  if (tokenUsagePositionFrame !== undefined) return;
  tokenUsagePositionFrame = window.requestAnimationFrame(() => {
    tokenUsagePositionFrame = undefined;
    updateTokenUsageTooltipPosition();
  });
}

function updateTokenUsageTooltipPosition(): void {
  const key = activeTokenUsageKey.value;
  if (!key) return;

  const trigger = tokenUsageTriggerRefs.get(key);
  const tooltip = tokenUsageTooltipRefs.get(key);
  if (!trigger || !tooltip) return;

  const margin = 8;
  const gap = 8;
  const viewport = viewportSize();
  const maxWidth = Math.max(160, viewport.width - margin * 2);
  const triggerRect = trigger.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const tooltipWidth = Math.min(tooltipRect.width, maxWidth);

  const tooltipHeight = tooltipRect.height;
  const topWhenAbove = triggerRect.top - gap - tooltipHeight;
  const topWhenBelow = triggerRect.bottom + gap;
  const fitsAbove = topWhenAbove >= margin;
  const fitsBelow = topWhenBelow + tooltipHeight <= viewport.height - margin;
  const spaceAbove = triggerRect.top - margin - gap;
  const spaceBelow = viewport.height - triggerRect.bottom - margin - gap;
  // 默认优先显示在下方；只有下方放不下时，才尝试上方或选择空间更大的方向。
  const placeTop = !fitsBelow && (fitsAbove || spaceAbove >= spaceBelow);
  const rawTop = placeTop ? topWhenAbove : topWhenBelow;

  const left = clamp(triggerRect.right - tooltipWidth, margin, viewport.width - tooltipWidth - margin);
  const top = clamp(
    rawTop,
    margin,
    viewport.height - tooltipHeight - margin
  );
  const triggerCenter = triggerRect.left + triggerRect.width / 2;
  const arrowLeft = clamp(triggerCenter - left, 12, tooltipWidth - 12);

  tokenUsageTooltipPlacement.value = placeTop ? 'top' : 'bottom';
  tokenUsageTooltipStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    maxWidth: `${Math.round(maxWidth)}px`,
    '--token-usage-arrow-left': `${Math.round(arrowLeft)}px`
  };
}

function attachTokenUsagePositionListeners(): void {
  if (tokenUsagePositionListenersAttached) return;
  window.addEventListener('resize', scheduleTokenUsageTooltipPosition);
  window.addEventListener('scroll', scheduleTokenUsageTooltipPosition, true);
  tokenUsagePositionListenersAttached = true;
}

function detachTokenUsagePositionListeners(): void {
  if (!tokenUsagePositionListenersAttached) return;
  window.removeEventListener('resize', scheduleTokenUsageTooltipPosition);
  window.removeEventListener('scroll', scheduleTokenUsageTooltipPosition, true);
  tokenUsagePositionListenersAttached = false;
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

async function copyMessage(): Promise<void> {
  const text = messageText.value;
  if (!text) return;

  const ok = await writeClipboard(text);
  if (!ok) return;

  copied.value = true;
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
  copiedResetTimer = window.setTimeout(() => {
    copied.value = false;
    copiedResetTimer = undefined;
  }, 1400);
}

async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // VS Code Webview / 老环境可能拒绝 Clipboard API，继续尝试 textarea fallback。
    }
  }

  return writeClipboardFallback(text);
}

function writeClipboardFallback(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';

  try {
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch (error) {
    console.warn('[LimCode] Failed to copy message.', error);
    return false;
  } finally {
    textarea.remove();
  }
}

function openDeleteConfirm(): void {
  confirmDeleteOpen.value = true;
}

function editMessage(): void {
  emit('edit-message', props.message);
}

function viewRunDetail(): void {
  emit('view-run-detail', props.message);
}

function openRetryConfirm(): void {
  confirmRetryOpen.value = true;
}

function cancelRetry(): void {
  confirmRetryOpen.value = false;
}

function confirmRetry(): void {
  emit('retry-from', props.message);
  confirmRetryOpen.value = false;
}

function cancelDelete(): void {
  confirmDeleteOpen.value = false;
}

function confirmDelete(): void {
  emit('delete-from', props.message);
  confirmDeleteOpen.value = false;
}

function onDeleteConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') cancelDelete();
  if (action.key === 'confirm') confirmDelete();
}

function onRetryConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') cancelRetry();
  if (action.key === 'confirm') confirmRetry();
}
</script>

<template>
  <article class="message-floor" :class="[message.role, { streaming, 'is-deleting': deleting, 'is-entering': entering, 'is-edit-target': editingHighlighted }]" :data-scroll-marker-id="message.id">
    <div class="floor-container">
      <div class="floor-content-column">
        <header class="floor-header">
          <span class="role-chip" :class="message.role === 'user' ? 'user' : 'assistant'">
            <span class="role-dot" aria-hidden="true"></span>
            <span class="floor-role-name">{{ roleLabel }}</span>
          </span>
          <span v-if="streaming" class="floor-status-badge is-streaming">正在输入</span>
          <span
            v-else-if="stopReasonLabel"
            class="floor-status-badge is-stop"
            :class="stopReasonClass"
            :title="stopReasonTitle"
          >
            {{ stopReasonLabel }}
          </span>
        </header>
        <div class="floor-body">
          <RichContentView
            :parts="message.content.parts"
            :markdown="message.role !== 'user'"
            :streaming="streaming"
            :message-id="message.id"
          />
        </div>
        <footer v-if="tokenUsageItems.length > 0" class="token-usage-row" aria-label="Token 用量">
          <span
            v-for="item in tokenUsageItems"
            :key="item.key"
            class="token-usage-item"
            :ref="(element) => setTokenUsageTriggerRef(item.key, element)"
            :aria-label="`${item.label} token ${item.exact}`"
            tabindex="0"
            @mouseenter="showTokenUsageTooltip(item.key)"
            @mouseleave="hideTokenUsageTooltip(item.key)"
            @focus="showTokenUsageTooltip(item.key)"
            @blur="hideTokenUsageTooltip(item.key)"
          >
            <IconHash v-if="item.key === 'total'" class="token-usage-icon" stroke="2" aria-hidden="true" />
            <IconArrowNarrowUp
              v-else-if="item.key === 'input'"
              class="token-usage-icon"
              stroke="2"
              aria-hidden="true"
            />
            <IconArrowNarrowDown v-else class="token-usage-icon" stroke="2" aria-hidden="true" />
            <span class="token-usage-value">{{ item.compact }}</span>
            <span v-if="item.suffix" class="token-usage-suffix">{{ item.suffix }}</span>
            <span
              :ref="(element) => setTokenUsageTooltipRef(item.key, element)"
              class="token-usage-tooltip"
              :class="{
                'is-active': activeTokenUsageKey === item.key,
                'is-placement-top': activeTokenUsageKey === item.key && tokenUsageTooltipPlacement === 'top',
                'is-placement-bottom': activeTokenUsageKey === item.key && tokenUsageTooltipPlacement === 'bottom'
              }"
              :style="activeTokenUsageKey === item.key ? tokenUsageTooltipStyle : undefined"
              role="tooltip"
              @mouseenter="showTokenUsageTooltip(item.key)"
              @mouseleave="hideTokenUsageTooltip(item.key)"
            >
              <span class="token-usage-tooltip-title">{{ item.label }} token</span>
              <span class="token-usage-tooltip-row">
                <span class="token-usage-tooltip-label">精确值</span>
                <span class="token-usage-tooltip-value">{{ item.exact }}</span>
              </span>
              <template v-if="item.details.length > 0">
                <span class="token-usage-tooltip-divider" aria-hidden="true"></span>
                <span
                  v-for="(detail, index) in item.details"
                  :key="`${detail.label}-${index}`"
                  class="token-usage-tooltip-row"
                  :class="{ 'is-nested': (detail.depth ?? 0) > 0 }"
                >
                  <span class="token-usage-tooltip-label">{{ detail.label }}</span>
                  <span class="token-usage-tooltip-value">{{ detail.value }}</span>
                </span>
              </template>
            </span>
          </span>
        </footer>
      </div>
    </div>
    <div class="message-actions" aria-label="消息操作">
      <button
        v-if="message.role === 'user'"
        type="button"
        class="message-action-button"
        aria-label="编辑消息"
        title="编辑消息"
        @click="editMessage"
      >
        <IconEdit class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        v-if="message.role !== 'user'"
        type="button"
        class="message-action-button"
        aria-label="重试此消息"
        title="重试此消息"
        @click="openRetryConfirm"
      >
        <IconRefresh class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="message-action-button"
        :class="{ 'is-copied': copied }"
        :disabled="!messageText"
        :aria-label="copied ? '已复制消息' : '复制消息'"
        :title="copied ? '已复制' : '复制消息'"
        @click="copyMessage"
      >
        <IconCheck v-if="copied" class="message-action-icon" stroke="2" aria-hidden="true" />
        <IconCopy v-else class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="message-action-button"
        aria-label="删除到此消息"
        title="删除到此消息"
        @click="openDeleteConfirm"
      >
        <IconTrash class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        v-if="message.role !== 'user'"
        type="button"
        class="message-action-button"
        :class="{ 'is-loading': runDetailLoading }"
        :disabled="runDetailLoading"
        aria-label="查看本次 LLM 调用详情"
        title="查看本次 LLM 调用详情"
        @click="viewRunDetail"
      >
        <IconEye class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
    </div>
    <ConfirmPanel
      :open="confirmRetryOpen"
      title="重试消息？"
      :description-html="retryDescriptionHtml"
      :actions="retryConfirmActions"
      @action="onRetryConfirmAction"
    />
    <ConfirmPanel
      :open="confirmDeleteOpen"
      title="删除消息？"
      :description-html="deleteDescriptionHtml"
      :actions="deleteConfirmActions"
      @action="onDeleteConfirmAction"
    />
  </article>
</template>

<style scoped>
.message-floor {
  position: relative;
  width: 100%;
  padding: var(--space-4) var(--conversation-content-padding-right, calc(var(--space-4) + 24px))
    var(--space-4) var(--conversation-content-padding-left, var(--space-4));
  box-sizing: border-box;
  background-color: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
  transition: background-color var(--lc-message-bg-transition-duration) ease;
}

.message-floor.user {
  background-color: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}

.message-floor.model,
.message-floor.assistant {
  background-color: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
}

.message-floor.is-deleting {
  pointer-events: none;
  animation: lc-message-exit-right var(--lc-message-exit-duration) var(--lc-motion-exit-standard) forwards;
  will-change: opacity, transform;
}

.message-floor.is-entering {
  animation: lc-message-enter var(--lc-message-enter-duration) var(--lc-motion-enter-emphasized) both;
  will-change: opacity, transform;
}

.message-floor.is-deleting .message-actions {
  opacity: 0;
}

.message-floor.is-edit-target {
  box-shadow: inset 0 0 0 1px var(--vscode-editorWarning-foreground, #cca700);
}

.floor-container {
  max-width: 100%;
}

.floor-content-column {
  width: 100%;
  min-width: 0;
}

.floor-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  padding-right: 118px;
  flex-wrap: wrap;
}

.message-actions {
  position: absolute;
  top: var(--space-2);
  right: var(--conversation-content-padding-right, calc(var(--space-4) + 24px));
  display: flex;
  align-items: center;
  gap: var(--space-1);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--lc-message-actions-fade-duration) ease-out;
}

.message-floor:hover .message-actions {
  opacity: 1;
  pointer-events: auto;
}

.message-action-button {
  width: 26px;
  height: 26px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
}

.message-action-button:hover:not(:disabled),
.message-action-button:focus-visible {
  color: var(--vscode-foreground);
  background: transparent;
  border-color: transparent;
}

.message-action-button:focus-visible {
  outline: none;
}

.message-action-button:disabled {
  opacity: 0.45;
  border-color: transparent;
  cursor: default;
}

.message-action-button.is-loading .message-action-icon {
  opacity: 0.55;
}

.message-action-icon {
  width: 15px;
  height: 15px;
  pointer-events: none;
}

.role-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.role-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: currentColor;
}

.role-chip.user {
  color: var(--vscode-testing-iconPassed, #4caf50);
}

.role-chip.assistant {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.floor-role-name {
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: currentColor;
}

.floor-status-badge {
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

.floor-status-badge.is-streaming {
  background-color: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.floor-status-badge.is-streaming::after {
  content: '';
  width: 6px;
  height: 6px;
  --lc-status-pulse-color: var(--vscode-testing-iconPassedColor, #4caf50);
  background-color: var(--vscode-testing-iconPassedColor, #4caf50);
  border-radius: 50%;
  display: inline-block;
  animation: lc-status-pulse-glow var(--lc-status-pulse-duration) infinite ease-in-out;
}

.floor-status-badge.is-stop {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  background-color: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.floor-status-badge.stop-paused {
  color: var(--vscode-testing-iconSkipped, var(--vscode-descriptionForeground));
}

.floor-status-badge.stop-cancelled {
  color: var(--vscode-errorForeground);
  border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
  background-color: var(--vscode-inputValidation-errorBackground, color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%));
}

.floor-status-badge.stop-replaced {
  color: var(--vscode-foreground);
  border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
}

.floor-status-badge.stop-stale {
  color: var(--vscode-descriptionForeground);
  border-style: dashed;
}


.floor-body {
  font-size: var(--font-size-md);
  line-height: 1.6;
  color: var(--vscode-foreground);
}

.message-floor.streaming .floor-body {
  min-height: 1.6em;
}

.token-usage-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1;
  user-select: none;
}

.token-usage-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 132px;
  color: var(--vscode-descriptionForeground);
  opacity: 1;
  cursor: default;
  outline: none;
}

.token-usage-item:hover {
  color: var(--vscode-foreground);
}

.token-usage-item:focus-visible {
  color: var(--vscode-foreground);
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 2px;
}

.token-usage-icon {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
}

.token-usage-value {
  font-variant-numeric: tabular-nums;
}

.token-usage-suffix {
  font-variant-numeric: tabular-nums;
}

.token-usage-tooltip {
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
  opacity: 0;
  visibility: hidden;
  transform: translateY(3px);
  transition:
    opacity 120ms ease,
    transform 120ms ease,
    visibility 120ms ease;
}

.token-usage-tooltip::after {
  content: '';
  position: absolute;
  left: var(--token-usage-arrow-left, calc(100% - 14px));
  width: 8px;
  height: 8px;
  background: inherit;
  transform: translateX(-50%) rotate(45deg);
}

.token-usage-tooltip.is-active {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

.token-usage-tooltip.is-placement-top::after {
  bottom: -5px;
  border-right: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
}

.token-usage-tooltip.is-placement-bottom::after {
  top: -5px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-left: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
}

.token-usage-tooltip-title {
  font-weight: 600;
  color: var(--vscode-foreground);
}

.token-usage-tooltip-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
}

.token-usage-tooltip-row.is-nested {
  padding-left: 10px;
}

.token-usage-tooltip-label {
  color: var(--vscode-descriptionForeground);
}

.token-usage-tooltip-value {
  flex: 0 0 auto;
  color: var(--vscode-foreground);
  font-variant-numeric: tabular-nums;
}

.token-usage-tooltip-divider {
  height: 1px;
  margin: 2px 0;
  background: var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
}
</style>
