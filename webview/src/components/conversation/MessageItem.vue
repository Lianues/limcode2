<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  IconArrowNarrowDown,
  IconArrowNarrowUp,
  IconBolt,
  IconCheck,
  IconClock,
  IconCopy,
  IconEdit,
  IconEye,
  IconHash,
  IconRefresh,
  IconTrash
} from '@tabler/icons-vue';
import { isVisibleTextPart, type CheckpointRecord, type LlmUsageMetadataRecord, type MessageRecord, type MessageStopReason } from '@shared/protocol';
import RichContentView from '@webview/components/content/RichContentView.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import { useCheckpointPolicyStore } from '@webview/stores/useCheckpointPolicyStore';
import { rollbackConfirmActionTitle } from './checkpointRollback';
import { normalizeTokenUsage } from './tokenUsageModel';

const props = withDefaults(
  defineProps<{
    message: MessageRecord;
    runId?: string;
    runDetailLoading?: boolean;
    deleteCount?: number;
    floorNumber?: number;
    rollbackCheckpoint?: CheckpointRecord;
    deleting?: boolean;
    entering?: boolean;
    editingHighlighted?: boolean;
  }>(),
  { runId: undefined, runDetailLoading: false, deleteCount: 1, floorNumber: 0, rollbackCheckpoint: undefined, deleting: false, entering: false, editingHighlighted: false }
);

const emit = defineEmits<{
  (event: 'edit-message', message: MessageRecord): void;
  (event: 'retry-from', message: MessageRecord): void;
  (event: 'delete-from', message: MessageRecord): void;
  (event: 'view-run-detail', message: MessageRecord): void;
}>();

const roleLabel = computed(() => {
  if (props.message.role === 'user') return '你';
  const model = props.message.model?.trim();
  return model || 'AI';
});
type RunMetricKey = 'time' | 'duration' | 'speed';
interface RunMetricDetailItem {
  label: string;
  value: string;
}
interface RunMetricItem {
  key: RunMetricKey;
  label: string;
  value: string;
  tooltipTitle: string;
  details: RunMetricDetailItem[];
}
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
const LOCAL_DAY_MS = 86_400_000;
const streaming = computed(() => props.message.status === 'streaming');
const checkpointStore = useCheckpointPolicyStore();
const copied = ref(false);
const confirmRetryOpen = ref(false);
const confirmDeleteOpen = ref(false);
const rollbackPending = ref(false);
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

  const normalized = normalizeTokenUsage(usage);
  const input = normalized.input;
  const output = normalized.output;
  const total = normalized.total;

  return [
    createTokenUsageItem('total', '总', total, usage),
    createTokenUsageItem('input', '输入', input, usage),
    createTokenUsageItem('output', '输出', output, usage)
  ].filter((item): item is TokenUsageItem => item !== undefined);
});

const runMetricItems = computed<RunMetricItem[]>(() => {
  const startedAt = normalizeTimestamp(props.message.createdAt);
  const timeMetric: RunMetricItem | undefined = startedAt !== undefined
    ? {
        key: 'time' as const,
        label: props.message.role === 'user' ? '发送时间' : '响应时间',
        value: formatCallTime(startedAt),
        tooltipTitle: props.message.role === 'user' ? '发送时间' : '响应时间',
        details: [{ label: props.message.role === 'user' ? '发送时间' : '开始获取响应', value: formatFullDateTime(startedAt) }]
      }
    : undefined;

  if (props.message.role === 'user' || streaming.value) {
    return [timeMetric].filter((item): item is RunMetricItem => item !== undefined);
  }

  const durationMs = normalizeDurationMs(props.message.streamOutputDurationMs);
  const outputTokens = props.message.usageMetadata
    ? normalizeTokenUsage(props.message.usageMetadata).output
    : undefined;
  const tokenSpeed = durationMs !== undefined && durationMs > 0 && outputTokens !== undefined
    ? outputTokens / (durationMs / 1000)
    : undefined;

  const items: Array<RunMetricItem | undefined> = [
    timeMetric,
    durationMs !== undefined
      ? {
          key: 'duration' as const,
          label: '耗时',
          value: formatDurationMs(durationMs),
          tooltipTitle: '总输出耗时',
          details: [{ label: '总耗时', value: formatDurationMs(durationMs) }]
        }
      : undefined,
    tokenSpeed !== undefined
      ? {
          key: 'speed' as const,
          label: '速度',
          value: formatTokenSpeed(tokenSpeed),
          tooltipTitle: '输出 token 速度（含思考）',
          details: [
            { label: '输出 token（含思考）', value: formatExactNumber(outputTokens!) },
            { label: '总耗时', value: formatDurationMs(durationMs!) },
            { label: '速度', value: formatTokenSpeedExact(tokenSpeed) }
          ]
        }
      : undefined
  ];
  return items.filter((item): item is RunMetricItem => item !== undefined);
});

const messageFooterVisible = computed(() => props.floorNumber > 0 || runMetricItems.value.length > 0 || tokenUsageItems.value.length > 0);

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

const rollbackConfirmAction = computed<ConfirmPanelAction>(() => ({
  key: 'rollback-confirm',
  label: rollbackPending.value ? '正在回档...' : '回档并确认',
  variant: rollbackPending.value || !props.rollbackCheckpoint ? 'secondary' : 'default',
  disabled: rollbackPending.value || !props.rollbackCheckpoint,
  title: rollbackConfirmActionTitle(props.rollbackCheckpoint)
}));
const deleteConfirmActions = computed<ConfirmPanelAction[]>(() => {
  const actions: ConfirmPanelAction[] = [
    { key: 'cancel', label: '取消', variant: 'secondary', disabled: rollbackPending.value }
  ];
  if (props.rollbackCheckpoint || rollbackPending.value) actions.push(rollbackConfirmAction.value);
  actions.push({ key: 'confirm', label: '删除', disabled: rollbackPending.value });
  return actions;
});
const retryConfirmActions = computed<ConfirmPanelAction[]>(() => {
  const actions: ConfirmPanelAction[] = [
    { key: 'cancel', label: '取消', variant: 'secondary', disabled: rollbackPending.value }
  ];
  if (props.rollbackCheckpoint || rollbackPending.value) actions.push(rollbackConfirmAction.value);
  actions.push({ key: 'confirm', label: '确认', disabled: rollbackPending.value });
  return actions;
});

onBeforeUnmount(() => {
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
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

function usageNumber(usage: LlmUsageMetadataRecord, keys: readonly string[]): number | undefined {
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

function normalizeTimestamp(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeDurationMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatCallTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const dayDiff = localDayNumber(now) - localDayNumber(date);
  const monthDiff = localMonthNumber(now) - localMonthNumber(date);
  const shortTime = formatTimeOfDay(date);

  if (dayDiff === 0) return formatTimeOfDay(date, { seconds: true });
  if (dayDiff === 1) return `昨天 ${shortTime}`;
  if (dayDiff === 2) return `前天 ${shortTime}`;
  if (dayDiff === -1) return `明天 ${shortTime}`;
  if (dayDiff > 2 && isSameLocalMonth(date, now)) return `本月 ${date.getDate()}日 ${shortTime}`;
  if (monthDiff === 1) return `上个月 ${date.getDate()}日 ${shortTime}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${shortTime}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${shortTime}`;
}

function formatFullDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatTimeOfDay(date, { seconds: true })} ${formatTimezoneLabel(date)}`;
}

function formatTimeOfDay(date: Date, options: { seconds?: boolean } = {}): string {
  const base = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return options.seconds ? `${base}:${pad2(date.getSeconds())}` : base;
}

function isSameLocalMonth(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth();
}

function localDayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / LOCAL_DAY_MS);
}

function localMonthNumber(date: Date): number {
  return date.getFullYear() * 12 + date.getMonth();
}

function formatTimezoneLabel(date: Date): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `UTC${sign}${pad2(Math.floor(absoluteOffset / 60))}:${pad2(absoluteOffset % 60)}`;
  return timeZone ? `${timeZone} ${offset}` : offset;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDurationMs(durationMs: number): string {
  const safeDuration = Math.max(0, durationMs);
  if (safeDuration < 1000) return `${Math.round(safeDuration)}ms`;
  const seconds = safeDuration / 1000;
  if (seconds < 60) {
    const digits = seconds < 10 ? 1 : 0;
    return `${trimFixed(seconds, digits)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes}m${restSeconds.toString().padStart(2, '0')}s`;
}

function formatTokenSpeed(speed: number): string {
  const abs = Math.abs(speed);
  if (abs >= 1000) return `${(speed / 1000).toFixed(1)}k tok/s`;
  return `${speed.toFixed(1)} tok/s`;
}

function formatTokenSpeedExact(speed: number): string {
  return `${speed.toFixed(1)} tok/s`;
}

function trimFixed(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
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
    const thoughts = normalizeTokenUsage(usage).reasoning;
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
      return outputTokenDetails(usage);
  }
  return [];
}

function usageDetailItems(usage: LlmUsageMetadataRecord, keys: readonly string[]): TokenUsageDetailItem[] {
  const details: TokenUsageDetailItem[] = [];
  for (const key of keys) {
    if (!hasOwn.call(usage, key)) continue;
    const item = detailItemFromValue(key, usage[key], 0);
    if (item) details.push(...item);
  }
  return details;
}

function outputTokenDetails(usage: LlmUsageMetadataRecord): TokenUsageDetailItem[] {
  const normalized = normalizeTokenUsage(usage);
  const thoughts = normalized.reasoning;
  if (thoughts === undefined) return [];

  const bodyTokens = normalized.output !== undefined ? Math.max(0, normalized.output - thoughts) : undefined;
  return [
    ...(bodyTokens !== undefined ? [{ label: '正文 token', value: formatExactNumber(bodyTokens) }] : []),
    ...usageDetailItems(usage, ['thoughtsTokenCount', 'reasoning_tokens'])
  ];
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

function tokenUsageTooltipRows(item: TokenUsageItem): TooltipPanelItem[] {
  const rows: TooltipPanelItem[] = [{ label: '精确值', value: item.exact }];
  if (item.details.length > 0) {
    rows.push({ kind: 'divider', id: `${item.key}-details` });
    rows.push(...item.details.map((detail): TooltipPanelRow => ({
      label: detail.label,
      value: detail.value,
      nested: (detail.depth ?? 0) > 0
    })));
  }
  return rows;
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

async function restoreBeforeConfirm(): Promise<boolean> {
  if (!props.rollbackCheckpoint || rollbackPending.value) return false;
  rollbackPending.value = true;
  try {
    const checkpoint = props.rollbackCheckpoint;
    const result = await checkpointStore.restoreCheckpoint(checkpoint);
    if (result.status !== 'restored') return false;
    checkpointStore.dismissCheckpoint(checkpoint.id, checkpoint.conversationId);
    return true;
  } finally {
    rollbackPending.value = false;
  }
}

function confirmRetry(): void {
  emit('retry-from', props.message);
  confirmRetryOpen.value = false;
}

async function rollbackAndConfirmRetry(): Promise<void> {
  if (await restoreBeforeConfirm()) confirmRetry();
}

function cancelDelete(): void {
  confirmDeleteOpen.value = false;
}

function confirmDelete(): void {
  emit('delete-from', props.message);
  confirmDeleteOpen.value = false;
}

async function rollbackAndConfirmDelete(): Promise<void> {
  if (await restoreBeforeConfirm()) confirmDelete();
}

function onDeleteConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') cancelDelete();
  if (action.key === 'rollback-confirm') void rollbackAndConfirmDelete();
  if (action.key === 'confirm') confirmDelete();
}

function onRetryConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') cancelRetry();
  if (action.key === 'rollback-confirm') void rollbackAndConfirmRetry();
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
        <footer v-if="messageFooterVisible" class="message-footer">
          <div v-if="floorNumber > 0 || runMetricItems.length > 0" class="message-run-metrics" aria-label="消息楼层与 LLM 调用指标">
            <span v-if="floorNumber > 0" class="message-floor-index">#{{ floorNumber }}</span>
            <HoverTooltipPanel
              v-for="metric in runMetricItems"
              :key="metric.key"
              class="message-run-metric"
              :class="`is-${metric.key}`"
              :aria-label="`${metric.label} ${metric.value}`"
              :panel-title="metric.tooltipTitle"
              :rows="metric.details"
              tabindex="0"
            >
              <IconClock v-if="metric.key === 'duration'" class="message-run-metric-icon" stroke="2" aria-hidden="true" />
              <IconBolt v-else-if="metric.key === 'speed'" class="message-run-metric-icon" stroke="2" aria-hidden="true" />
              <span class="message-run-metric-value">{{ metric.value }}</span>
            </HoverTooltipPanel>
          </div>
          <div v-if="tokenUsageItems.length > 0" class="token-usage-row" aria-label="Token 用量">
            <HoverTooltipPanel
              v-for="item in tokenUsageItems"
              :key="item.key"
              class="token-usage-item"
              :aria-label="`${item.label} token ${item.exact}`"
              :panel-title="`${item.label} token`"
              :rows="tokenUsageTooltipRows(item)"
              tabindex="0"
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
            </HoverTooltipPanel>
          </div>
        </footer>
      </div>
    </div>
    <div class="message-actions" aria-label="消息操作">
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
    </div>
    <ConfirmPanel
      :open="confirmRetryOpen"
      title="重试消息？"
      :description-html="retryDescriptionHtml"
      :actions="retryConfirmActions"
      @action="onRetryConfirmAction"
      @cancel="cancelRetry"
    />
    <ConfirmPanel
      :open="confirmDeleteOpen"
      title="删除消息？"
      :description-html="deleteDescriptionHtml"
      :actions="deleteConfirmActions"
      @action="onDeleteConfirmAction"
      @cancel="cancelDelete"
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

.message-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  margin-top: var(--space-2);
}

.message-run-metrics {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  flex: 1 1 auto;
  flex-wrap: wrap;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 14px;
  user-select: none;
}

.message-floor-index {
  display: inline-flex;
  align-items: center;
  height: 14px;
  color: var(--vscode-descriptionForeground);
  font-weight: 500;
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  line-height: 14px;
  opacity: 0.78;
}

.message-run-metric,
.token-usage-item {
  display: inline-flex;
  align-items: center;
  height: 14px;
  line-height: 14px;
  white-space: nowrap;
  cursor: default;
  outline: none;
}

.message-run-metric {
  min-width: 0;
  gap: 4px;
  color: inherit;
  opacity: 0.78;
}

.message-run-metric.is-time {
  opacity: 0.82;
}

.message-run-metric:hover {
  color: var(--vscode-foreground);
  opacity: 0.96;
}

.message-run-metric:focus-visible {
  color: var(--vscode-foreground);
  opacity: 0.96;
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 2px;
}

.message-run-metric-icon,
.token-usage-icon {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  display: block;
}

.message-run-metric-value,
.token-usage-value,
.token-usage-suffix {
  display: inline-flex;
  align-items: center;
  height: 14px;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  line-height: 14px;
}

.message-run-metric-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.token-usage-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 14px;
  user-select: none;
}

.token-usage-item {
  position: relative;
  gap: 2px;
  max-width: 132px;
  color: var(--vscode-descriptionForeground);
  opacity: 1;
}

.token-usage-item:hover {
  color: var(--vscode-foreground);
}

.token-usage-item:focus-visible {
  color: var(--vscode-foreground);
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 2px;
}

</style>
