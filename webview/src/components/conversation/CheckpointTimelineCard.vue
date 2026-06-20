<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { IconArrowBackUp, IconGitCommit, IconX } from '@tabler/icons-vue';
import type { CheckpointRecord, CheckpointTimelineAnchorRecord } from '@shared/protocol';
import { useCheckpointPolicyStore } from '@webview/stores/useCheckpointPolicyStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';

const LOCAL_DAY_MS = 86_400_000;

const props = defineProps<{
  checkpoint: CheckpointRecord;
  anchor?: CheckpointTimelineAnchorRecord;
  phase?: 'stable' | 'entering' | 'exiting';
}>();

const checkpointStore = useCheckpointPolicyStore();
const clientState = useClientStateStore();
const settings = useGlobalSettingsStore();

const shadowRepository = computed(() => clientState.shadowRepositories.find((item) => item.id === props.checkpoint.shadowRepositoryId));
const shadowRepositoryStat = computed(() => {
  if (!shadowRepository.value) return undefined;
  return checkpointStore.shadowStats.find((item) => item.storageKey === shadowRepository.value?.storageKey);
});

const shadowStatsConfirmationRequestedAt = ref(0);

const shadowRepositoryStatus = computed<'available' | 'checking' | 'missing'>(() => {
  if (props.checkpoint.status !== 'created') return 'available';
  if (!shadowRepository.value) return 'available';
  if (shadowRepositoryStat.value?.exists) return 'available';
  if (shadowRepositoryStat.value && !shadowRepositoryStat.value.exists) return 'missing';
  if (!checkpointStore.shadowStatsLoaded) return 'checking';
  if (shadowStatsConfirmationRequestedAt.value <= 0) return 'checking';
  if (checkpointStore.shadowStatsLoadedAt < shadowStatsConfirmationRequestedAt.value) return 'checking';
  return 'missing';
});

const shadowChecking = computed(() => shadowRepositoryStatus.value === 'checking');
const shadowMissing = computed(() => shadowRepositoryStatus.value === 'missing');
const shadowRepositoryStatusLabel = computed(() => {
  if (shadowChecking.value) return '检查中';
  if (shadowMissing.value) return '仓库已删除';
  return undefined;
});
const shadowRepositoryStatusTitle = computed(() => {
  if (shadowChecking.value) return '正在确认此存档点的 shadow 仓库状态。';
  if (shadowMissing.value) return '该存档点的 shadow 仓库已被删除，无法回档。';
  return undefined;
});

const isPending = computed(() => props.checkpoint.status === 'pending');
const canDismiss = computed(() => props.checkpoint.trigger === 'conversation_initial' && !isPending.value);
const canAutoDismiss = computed(() => props.checkpoint.status === 'failed' || (props.checkpoint.status === 'skipped' && props.checkpoint.skipReason !== 'no_changes'));
const canRestore = computed(() => props.checkpoint.status === 'created' && !!props.checkpoint.commitSha && !!shadowRepository.value && shadowRepositoryStatus.value === 'available');
const projectLabel = computed(() => props.checkpoint.projectDisplayPath || props.checkpoint.projectUri);
const commitLabel = computed(() => props.checkpoint.commitSha?.slice(0, 8));
const sizeLabel = computed(() => props.checkpoint.byteCount === undefined ? undefined : formatBytes(props.checkpoint.byteCount));
const fileCountLabel = computed(() => props.checkpoint.fileCount === undefined ? undefined : `${props.checkpoint.fileCount} 文件`);
const timeLabel = computed(() => formatCheckpointTime(props.checkpoint.createdAt));
const timeTitle = computed(() => formatFullDateTime(props.checkpoint.createdAt));

const restoreButtonTitle = computed(() => {
  if (props.checkpoint.status !== 'created') return '只有已创建的存档点可以回档。';
  if (!props.checkpoint.commitSha) return '该存档点没有可回档的快照。';
  if (!shadowRepository.value) return '未找到此存档点关联的 shadow 仓库。';
  if (shadowChecking.value) return '正在确认 shadow 仓库状态，请稍候。';
  if (shadowMissing.value) return 'shadow 仓库已删除，无法回档。';
  return '将当前工作区恢复到此存档点';
});
const restoreConfirmDescription = computed(() => {
  const fileCount = props.checkpoint.fileCount !== undefined ? `约 ${props.checkpoint.fileCount} 个文件` : '存档文件';
  return `将把 ${projectLabel.value} 恢复到此存档点（${fileCount}）。当前工作区中存档后新增且未被策略排除的文件会被移除，请确认需要保留的修改已另行保存。`;
});

const dismissCountdown = ref(0);
const restoreConfirmOpen = ref(false);
let dismissTimer: ReturnType<typeof setInterval> | undefined;

const restoreConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '回档', variant: 'danger' }
];

function beginRestore(): void {
  if (!canRestore.value) return;
  restoreConfirmOpen.value = true;
}

function onRestoreConfirmAction(action: ConfirmPanelAction): void {
  restoreConfirmOpen.value = false;
  if (action.key !== 'confirm' || !canRestore.value) return;
  checkpointStore.restoreCheckpoint(props.checkpoint);
}

function dismiss(): void {
  checkpointStore.dismissCheckpoint(props.checkpoint.id, props.checkpoint.conversationId);
}

function clearDismissTimer(): void {
  if (dismissTimer !== undefined) {
    clearInterval(dismissTimer);
    dismissTimer = undefined;
  }
}

function refreshShadowStatsIfNeeded(): void {
  if (shadowRepositoryStatus.value !== 'checking') return;
  if (!shadowRepository.value) return;
  if (shadowStatsConfirmationRequestedAt.value > 0) return;
  if (checkpointStore.shadowStatsLoading) return;
  shadowStatsConfirmationRequestedAt.value = Date.now();
  checkpointStore.requestShadowStats();
}

function refreshAutoDismiss(): void {
  clearDismissTimer();
  dismissCountdown.value = 0;
  if (!canAutoDismiss.value) return;
  if (!settings.loadedSections.checkpointMaintenance) return;
  if (!settings.checkpointMaintenance.autoDismissEnabled) return;
  dismissCountdown.value = Math.max(1, Math.floor(settings.checkpointMaintenance.autoDismissSeconds || 5));
  dismissTimer = setInterval(() => {
    dismissCountdown.value -= 1;
    if (dismissCountdown.value <= 0) {
      clearDismissTimer();
      dismiss();
    }
  }, 1000);
}

onMounted(() => {
  checkpointStore.ensureShadowStats();
  settings.ensureCheckpointMaintenance();
  refreshShadowStatsIfNeeded();
  refreshAutoDismiss();
});

watch(
  [
    () => settings.loadedSections.checkpointMaintenance,
    () => settings.checkpointMaintenance.autoDismissEnabled,
    () => settings.checkpointMaintenance.autoDismissSeconds,
    () => props.checkpoint.status,
    () => props.checkpoint.skipReason,
    () => props.checkpoint.trigger
  ],
  () => refreshAutoDismiss()
);

let lastShadowRepositoryStorageKey = shadowRepository.value?.storageKey;

watch(
  [
    () => props.checkpoint.status,
    () => shadowRepository.value?.storageKey,
    () => shadowRepositoryStat.value?.exists,
    () => checkpointStore.shadowStatsLoaded,
    () => checkpointStore.shadowStatsLoading,
    () => checkpointStore.shadowStatsLoadedAt
  ],
  () => {
    const storageKey = shadowRepository.value?.storageKey;
    if (storageKey !== lastShadowRepositoryStorageKey) shadowStatsConfirmationRequestedAt.value = 0;
    lastShadowRepositoryStorageKey = storageKey;
    refreshShadowStatsIfNeeded();
  }
);

onUnmounted(() => clearDismissTimer());

const triggerLabel = computed(() => {
  switch (props.checkpoint.trigger) {
    case 'conversation_initial': return '初始存档';
    case 'user_message_before': return '用户消息前';
    case 'user_message_after': return '用户消息后';
    case 'llm_response_before': return '每次调用 AI 前';
    case 'llm_response_after': return '每次调用 AI 后';
    case 'tool_execution_before': return '工具执行前';
    case 'tool_execution_after': return '工具执行后';
    case 'agent_run_completed_before': return '整回合回复完成前';
    case 'agent_run_completed_after': return '整回合回复完成后';
    case 'manual': return '手动';
  }
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function formatCheckpointTime(timestamp: number): string {
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
</script>

<template>
  <section class="checkpoint-timeline-card" :class="[`is-${checkpoint.status}`, phase ? `is-${phase}` : undefined]">
    <div class="checkpoint-card-main">
      <IconGitCommit class="checkpoint-leading-icon" stroke="2" aria-hidden="true" />
      <span class="checkpoint-project" :title="projectLabel">{{ projectLabel }}</span>
      <template v-if="isPending">
        <span class="checkpoint-pending-text">创建中...</span>
      </template>
      <template v-else>
        <span v-if="commitLabel" class="checkpoint-commit checkpoint-result-field">{{ commitLabel }}</span>
        <span v-if="sizeLabel" class="checkpoint-meta-item checkpoint-result-field">{{ sizeLabel }}</span>
        <span v-if="fileCountLabel" class="checkpoint-meta-item checkpoint-result-field">{{ fileCountLabel }}</span>
        <span class="checkpoint-summary checkpoint-result-field">{{ triggerLabel }}</span>
        <span class="checkpoint-time checkpoint-result-field" :title="timeTitle">{{ timeLabel }}</span>
      </template>
      <span
        v-if="shadowRepositoryStatusLabel"
        class="checkpoint-repository-status"
        :class="`is-${shadowRepositoryStatus}`"
        :aria-label="shadowRepositoryStatusTitle"
      >{{ shadowRepositoryStatusLabel }}</span>
      <span
        v-if="dismissCountdown > 0"
        class="checkpoint-dismiss-countdown"
        :title="`${dismissCountdown} 秒后自动移除`"
      >{{ dismissCountdown }}s</span>
      <div v-if="!isPending" class="checkpoint-actions" aria-label="存档点操作">
        <button
          type="button"
          class="checkpoint-action-button"
          :disabled="!canRestore"
          :title="restoreButtonTitle"
          aria-label="回档到此存档点"
          @click="beginRestore"
        >
          <IconArrowBackUp class="checkpoint-action-icon" stroke="2" aria-hidden="true" />
          <span>回档</span>
        </button>
        <button
          v-if="canDismiss"
          type="button"
          class="checkpoint-dismiss-button"
          title="移除此存档点记录"
          aria-label="移除此存档点记录"
          @click="dismiss"
        >
          <IconX stroke="2" aria-hidden="true" />
        </button>
      </div>
    </div>
    <ConfirmPanel
      :open="restoreConfirmOpen"
      title="回档到此存档点？"
      :description="restoreConfirmDescription"
      :actions="restoreConfirmActions"
      danger
      @action="onRestoreConfirmAction"
      @cancel="restoreConfirmOpen = false"
    />
  </section>
</template>

<style scoped>
.checkpoint-timeline-card {
  display: flex;
  padding: 6px var(--conversation-content-padding-right, calc(var(--space-4) + 24px))
    6px var(--conversation-content-padding-left, var(--space-4));
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  box-sizing: border-box;
}

.checkpoint-timeline-card.is-exiting {
  pointer-events: none;
  animation: lc-message-exit-right var(--lc-message-exit-duration) var(--lc-motion-exit-standard) forwards;
}

.checkpoint-card-main {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.checkpoint-leading-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
}

.checkpoint-pending-text {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 16px;
}

.checkpoint-result-field {
  animation: checkpoint-result-in 140ms ease-out;
}

.checkpoint-project {
  min-width: 0;
  max-width: min(280px, 40%);
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family);
  font-size: var(--font-size-xs);
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.checkpoint-commit {
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family);
  font-size: var(--font-size-xs);
  line-height: 16px;
}

.checkpoint-summary,
.checkpoint-time,
.checkpoint-meta-item {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 16px;
}

.checkpoint-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.checkpoint-repository-status {
  font-size: var(--font-size-xs);
  line-height: 16px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 6px;
  animation: checkpoint-result-in 140ms ease-out;
}

.checkpoint-repository-status.is-checking {
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.checkpoint-repository-status.is-missing {
  color: var(--vscode-errorForeground);
  border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-errorForeground) 6%);
}

.checkpoint-actions {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.checkpoint-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 20px;
  padding: 0 6px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
  font-size: var(--font-size-xs);
  line-height: 18px;
  cursor: pointer;
}

.checkpoint-action-button:hover:not(:disabled),
.checkpoint-action-button:focus-visible {
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  outline: none;
}

.checkpoint-action-button:disabled {
  opacity: 0.45;
  cursor: default;
}

.checkpoint-action-icon {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
}

.checkpoint-dismiss-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
}

.checkpoint-dismiss-button:hover,
.checkpoint-dismiss-button:focus-visible {
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  color: var(--vscode-foreground);
  outline: none;
}

.checkpoint-dismiss-button svg {
  width: 14px;
  height: 14px;
}

.checkpoint-dismiss-countdown {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}

@keyframes checkpoint-result-in {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
