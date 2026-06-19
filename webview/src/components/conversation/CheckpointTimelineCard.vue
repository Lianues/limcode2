<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { IconGitCommit, IconX } from '@tabler/icons-vue';
import type { CheckpointRecord, CheckpointTimelineAnchorRecord } from '@shared/protocol';
import { useCheckpointPolicyStore } from '@webview/stores/useCheckpointPolicyStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { checkpointTimelineActions } from './checkpointTimelineActions';

const props = defineProps<{
  checkpoint: CheckpointRecord;
  anchor: CheckpointTimelineAnchorRecord;
  messageFloorNumber: number;
  phase?: 'stable' | 'entering' | 'exiting';
}>();

const actions = checkpointTimelineActions();
const checkpointStore = useCheckpointPolicyStore();
const clientState = useClientStateStore();
const settings = useGlobalSettingsStore();

const shadowMissing = computed(() => {
  if (!checkpointStore.shadowStatsLoaded || props.checkpoint.status !== 'created') return false;
  const repo = clientState.shadowRepositories.find((item) => item.id === props.checkpoint.shadowRepositoryId);
  if (!repo) return false;
  const stat = checkpointStore.shadowStats.find((item) => item.storageKey === repo.storageKey);
  return !stat || !stat.exists;
});

const canDismiss = computed(() => props.checkpoint.status === 'skipped' || props.checkpoint.status === 'failed');

const dismissCountdown = ref(0);
let dismissTimer: ReturnType<typeof setInterval> | undefined;

function dismiss(): void {
  checkpointStore.dismissCheckpoint(props.checkpoint.id, props.checkpoint.conversationId);
}

function clearDismissTimer(): void {
  if (dismissTimer !== undefined) {
    clearInterval(dismissTimer);
    dismissTimer = undefined;
  }
}

function refreshAutoDismiss(): void {
  clearDismissTimer();
  dismissCountdown.value = 0;
  if (!canDismiss.value) return;
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
  refreshAutoDismiss();
});

watch(
  [
    () => settings.loadedSections.checkpointMaintenance,
    () => settings.checkpointMaintenance.autoDismissEnabled,
    () => settings.checkpointMaintenance.autoDismissSeconds,
    () => props.checkpoint.status
  ],
  () => refreshAutoDismiss()
);

onUnmounted(() => clearDismissTimer());

const statusLabel = computed(() => {
  switch (props.checkpoint.status) {
    case 'created': return '已创建';
    case 'skipped': return '已跳过';
    case 'failed': return '失败';
  }
});

const triggerLabel = computed(() => {
  switch (props.checkpoint.trigger) {
    case 'user_message_after': return '用户消息后';
    case 'llm_response_after': return 'AI 回复后';
    case 'tool_execution_before': return '工具执行前';
    case 'tool_execution_after': return '工具执行后';
    case 'agent_run_completed_after': return '任务完成后';
    case 'manual': return '手动';
  }
});

const metaItems = computed(() => {
  const items: string[] = [];
  if (props.checkpoint.commitSha) items.push(`commit ${props.checkpoint.commitSha.slice(0, 8)}`);
  if (props.checkpoint.fileCount !== undefined) items.push(`${props.checkpoint.fileCount} 文件`);
  if (props.checkpoint.byteCount !== undefined) items.push(`${Math.round(props.checkpoint.byteCount / 1024)} KB`);
  return items;
});

function formatTime(value: number): string {
  return new Date(value).toLocaleString();
}
</script>

<template>
  <section class="checkpoint-timeline-card" :class="[`is-${checkpoint.status}`, phase ? `is-${phase}` : undefined]">
    <div class="checkpoint-card-main">
      <header class="checkpoint-card-header">
        <div class="checkpoint-card-title-row">
          <span class="checkpoint-title">存档点</span>
          <span class="checkpoint-status">{{ statusLabel }}</span>
          <span v-if="shadowMissing" class="checkpoint-missing" title="该存档点的 shadow 仓库已被删除，无法回档。">仓库已删除</span>
          <span class="checkpoint-summary">{{ triggerLabel }} · {{ formatTime(checkpoint.createdAt) }}</span>
          <span class="checkpoint-floor">#{{ messageFloorNumber }}</span>
        </div>
        <div class="checkpoint-actions" aria-label="存档点操作">
          <template v-if="canDismiss">
            <span
              v-if="dismissCountdown > 0"
              class="checkpoint-dismiss-countdown"
              :title="`${dismissCountdown} 秒后自动移除`"
            >{{ dismissCountdown }}s</span>
            <button
              type="button"
              class="checkpoint-dismiss-button"
              title="移除此存档点记录"
              aria-label="移除此存档点记录"
              @click="dismiss"
            >
              <IconX stroke="2" aria-hidden="true" />
            </button>
          </template>
          <template v-else>
            <button
              v-for="action in actions"
              :key="action.id"
              type="button"
              class="checkpoint-action-button"
              :disabled="!action.enabled({ checkpoint, anchor })"
              :title="shadowMissing && action.id === 'rollback' ? 'shadow 仓库已删除，无法回档。' : action.description"
              @click="action.run({ checkpoint, anchor })"
            >
              {{ action.label }}
            </button>
          </template>
        </div>
      </header>
      <div class="checkpoint-card-detail-row">
        <span class="checkpoint-path">{{ checkpoint.projectDisplayPath || checkpoint.projectUri }}</span>
        <span v-for="item in metaItems" :key="item" class="checkpoint-meta-item">
          <IconGitCommit v-if="item.startsWith('commit ')" class="checkpoint-meta-icon" stroke="2" aria-hidden="true" />
          <span>{{ item }}</span>
        </span>
        <span v-if="checkpoint.message" class="checkpoint-message">{{ checkpoint.message }}</span>
      </div>
    </div>
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
  flex-direction: column;
  gap: 3px;
}

.checkpoint-card-header,
.checkpoint-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.checkpoint-card-header {
  justify-content: space-between;
  min-width: 0;
}

.checkpoint-card-title-row,
.checkpoint-card-detail-row {
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.checkpoint-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  line-height: 18px;
}

.checkpoint-status,
.checkpoint-floor,
.checkpoint-summary,
.checkpoint-meta-item,
.checkpoint-message {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 16px;
}

.checkpoint-path {
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family);
  font-size: var(--font-size-xs);
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.checkpoint-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.checkpoint-meta-icon {
  width: 12px;
  height: 12px;
}

.checkpoint-missing {
  color: var(--vscode-errorForeground);
  font-size: var(--font-size-xs);
  line-height: 16px;
  border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: 0 6px;
}

.checkpoint-action-button {
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
</style>
