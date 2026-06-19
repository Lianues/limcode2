<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IconRefresh, IconTrash } from '@tabler/icons-vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import { useCheckpointPolicyStore } from '@webview/stores/useCheckpointPolicyStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';

interface ShadowRepoRow {
  storageKey: string;
  title: string;
  detail: string;
  sizeBytes: number;
  fileCount: number;
  checkpointCount: number;
  lastActiveAt?: number;
}

const checkpointStore = useCheckpointPolicyStore();
const clientState = useClientStateStore();
const settings = useGlobalSettingsStore();

const scroller = ref<HTMLElement | null>(null);
const selectedKeys = ref<string[]>([]);
const confirmOpen = ref(false);

const rows = computed<ShadowRepoRow[]>(() => {
  const repoByStorageKey = new Map(clientState.shadowRepositories.map((repo) => [repo.storageKey, repo]));
  const linkByRepoId = new Map<string, { conversationId: string; projectDisplayPath: string }>();
  for (const link of clientState.conversationCheckpointRepositoryLinks) {
    const current = linkByRepoId.get(link.shadowRepositoryId);
    if (!current || link.role === 'active') {
      linkByRepoId.set(link.shadowRepositoryId, { conversationId: link.conversationId, projectDisplayPath: link.projectDisplayPath });
    }
  }
  const checkpointCountByRepoId = new Map<string, number>();
  for (const checkpoint of clientState.checkpoints) {
    checkpointCountByRepoId.set(checkpoint.shadowRepositoryId, (checkpointCountByRepoId.get(checkpoint.shadowRepositoryId) ?? 0) + 1);
  }
  return checkpointStore.shadowStats.map((stat) => {
    const repo = repoByStorageKey.get(stat.storageKey);
    const link = repo ? linkByRepoId.get(repo.id) : undefined;
    const conversation = link ? clientState.conversations.find((item) => item.id === link.conversationId) : undefined;
    const conversationTitle = conversation?.title?.trim();
    const title = conversationTitle || link?.projectDisplayPath || stat.storageKey;
    const detail = conversationTitle && link?.projectDisplayPath ? link.projectDisplayPath : stat.storageKey;
    return {
      storageKey: stat.storageKey,
      title,
      detail,
      sizeBytes: stat.sizeBytes,
      fileCount: stat.fileCount,
      checkpointCount: repo ? (checkpointCountByRepoId.get(repo.id) ?? 0) : 0,
      ...(stat.lastActiveAt !== undefined ? { lastActiveAt: stat.lastActiveAt } : {})
    };
  });
});

const totalSizeBytes = computed(() => rows.value.reduce((sum, row) => sum + row.sizeBytes, 0));
const selectedSet = computed(() => new Set(selectedKeys.value));
const allSelected = computed(() => rows.value.length > 0 && rows.value.every((row) => selectedSet.value.has(row.storageKey)));
const someSelected = computed(() => selectedKeys.value.length > 0);

const autoCleanupEnabled = computed(() => settings.checkpointMaintenance.autoCleanupEnabled);
const autoCleanupDays = computed(() => settings.checkpointMaintenance.autoCleanupDays);
const autoDismissEnabled = computed(() => settings.checkpointMaintenance.autoDismissEnabled);
const autoDismissSeconds = computed(() => settings.checkpointMaintenance.autoDismissSeconds);

onMounted(() => {
  checkpointStore.requestShadowStats();
});

function isSelected(storageKey: string): boolean {
  return selectedSet.value.has(storageKey);
}

function toggleRow(storageKey: string, value: boolean): void {
  if (value) {
    if (!selectedKeys.value.includes(storageKey)) selectedKeys.value = [...selectedKeys.value, storageKey];
  } else {
    selectedKeys.value = selectedKeys.value.filter((key) => key !== storageKey);
  }
}

function toggleAll(value: boolean): void {
  selectedKeys.value = value ? rows.value.map((row) => row.storageKey) : [];
}

function refresh(): void {
  checkpointStore.requestShadowStats();
}

function openDeleteConfirm(): void {
  if (someSelected.value) confirmOpen.value = true;
}

function confirmDelete(): void {
  const keys = rows.value.filter((row) => selectedSet.value.has(row.storageKey)).map((row) => row.storageKey);
  checkpointStore.deleteShadowRepositories(keys);
  selectedKeys.value = [];
  confirmOpen.value = false;
}

function setAutoCleanupEnabled(value: boolean): void {
  settings.setCheckpointMaintenance({ autoCleanupEnabled: value });
}

function onAutoCleanupDaysChange(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  settings.setCheckpointMaintenance({ autoCleanupDays: Math.max(1, Math.floor(value)) });
}

function setAutoDismissEnabled(value: boolean): void {
  settings.setCheckpointMaintenance({ autoDismissEnabled: value });
}

function onAutoDismissSecondsChange(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  settings.setCheckpointMaintenance({ autoDismissSeconds: Math.max(1, Math.floor(value)) });
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString();
}
</script>

<template>
  <section class="shadow-manager" aria-label="shadow 仓库管理">
    <header class="shadow-manager-head">
      <div>
        <h3>shadow 仓库管理</h3>
        <p>每个 shadow 仓库是某个对话在某个项目下的存档点物理数据。删除只清理磁盘上的 git 仓库，不影响对话历史；被删除仓库的存档点将无法回档。</p>
      </div>
      <button type="button" class="shadow-icon-button" title="刷新统计" @click="refresh">
        <IconRefresh stroke="2" aria-hidden="true" />
      </button>
    </header>

    <div class="shadow-auto-clean">
      <LcCheckbox :model-value="autoCleanupEnabled" @update:model-value="setAutoCleanupEnabled">
        <span class="checkbox-text">
          <strong>自动清理长期未使用的 shadow 仓库</strong>
          <small>插件启动时，自动删除最近一段时间内没有活动的 shadow 仓库。</small>
        </span>
      </LcCheckbox>
      <span class="shadow-auto-clean-days" :class="{ 'is-disabled': !autoCleanupEnabled }">
        <span>未使用超过</span>
        <input type="number" min="1" max="3650" :value="autoCleanupDays" :disabled="!autoCleanupEnabled" @change="onAutoCleanupDaysChange" />
        <span>天</span>
      </span>
    </div>

    <div class="shadow-auto-clean">
      <LcCheckbox :model-value="autoDismissEnabled" @update:model-value="setAutoDismissEnabled">
        <span class="checkbox-text">
          <strong>自动移除异常存档点</strong>
          <small>失败、被跳过（如项目过大）等非正常存档点会在倒计时结束后自动从对话时间线移除。</small>
        </span>
      </LcCheckbox>
      <span class="shadow-auto-clean-days" :class="{ 'is-disabled': !autoDismissEnabled }">
        <input type="number" min="1" max="600" :value="autoDismissSeconds" :disabled="!autoDismissEnabled" @change="onAutoDismissSecondsChange" />
        <span>秒后移除</span>
      </span>
    </div>

    <div class="shadow-toolbar">
      <LcCheckbox :model-value="allSelected" :disabled="rows.length === 0" @update:model-value="toggleAll">
        <span class="shadow-toolbar-select-label">{{ allSelected ? '取消全选' : '全选' }}</span>
      </LcCheckbox>
      <span class="shadow-toolbar-summary">
        共 {{ rows.length }} 个 · 合计 {{ formatBytes(totalSizeBytes) }}
        <template v-if="someSelected"> · 已选 {{ selectedKeys.length }} 个</template>
      </span>
      <button type="button" class="shadow-delete-button" :disabled="!someSelected" @click="openDeleteConfirm">
        <IconTrash stroke="2" aria-hidden="true" />
        <span>删除选中</span>
      </button>
    </div>

    <div class="shadow-list-shell">
      <div ref="scroller" class="shadow-list-scroll">
        <div v-if="checkpointStore.shadowStatsLoading && rows.length === 0" class="shadow-empty">正在统计 shadow 仓库…</div>
        <div v-else-if="rows.length === 0" class="shadow-empty">暂无 shadow 仓库，创建存档点后会在此显示。</div>
        <div v-else class="shadow-rows">
          <div
            v-for="row in rows"
            :key="row.storageKey"
            class="shadow-row"
            :class="{ 'is-selected': isSelected(row.storageKey) }"
          >
            <LcCheckbox
              :model-value="isSelected(row.storageKey)"
              :aria-label="`选择 ${row.title}`"
              @update:model-value="(value) => toggleRow(row.storageKey, value)"
            />
            <div class="shadow-row-main">
              <span class="shadow-row-title">{{ row.title }}</span>
              <span class="shadow-row-detail">{{ row.detail }}</span>
            </div>
            <div class="shadow-row-stats">
              <span class="shadow-stat"><em>{{ formatBytes(row.sizeBytes) }}</em><small>大小</small></span>
              <span class="shadow-stat"><em>{{ row.fileCount }}</em><small>节点</small></span>
              <span class="shadow-stat"><em>{{ row.checkpointCount }}</em><small>存档点</small></span>
              <span class="shadow-stat shadow-stat-time"><em>{{ formatTime(row.lastActiveAt) }}</em><small>最近活跃</small></span>
            </div>
          </div>
        </div>
      </div>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" :refresh-key="rows.length" />
    </div>

    <ConfirmPanel
      :open="confirmOpen"
      title="删除选中的 shadow 仓库？"
      :description="`将删除 ${selectedKeys.length} 个 shadow 仓库的物理 git 数据，无法恢复。对话历史与存档点记录会保留，但这些存档点将无法回档。`"
      confirm-label="删除"
      @cancel="confirmOpen = false"
      @confirm="confirmDelete"
    />
  </section>
</template>

<style scoped>
.shadow-manager {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-foreground) 5%);
}

.shadow-manager-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-2);
}

.shadow-manager-head h3 {
  margin: 0;
  font-size: var(--font-size-md);
}

.shadow-manager-head p {
  margin: var(--space-1) 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.shadow-icon-button {
  flex: none;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.shadow-icon-button:hover {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  color: var(--vscode-foreground);
}

.shadow-icon-button svg {
  width: 16px;
  height: 16px;
}

.shadow-auto-clean {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  background: var(--vscode-editor-background);
}

.checkbox-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.checkbox-text small {
  color: var(--vscode-descriptionForeground);
}

.shadow-auto-clean-days {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.shadow-auto-clean-days.is-disabled {
  opacity: 0.5;
}

.shadow-auto-clean-days input {
  width: 64px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  padding: 2px var(--space-2);
  text-align: center;
}

.shadow-auto-clean-days input[type='number'] {
  appearance: textfield;
  -moz-appearance: textfield;
}

.shadow-auto-clean-days input[type='number']::-webkit-inner-spin-button,
.shadow-auto-clean-days input[type='number']::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.shadow-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.shadow-toolbar-select-label {
  font-size: var(--font-size-sm);
}

.shadow-toolbar-summary {
  flex: 1;
  min-width: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.shadow-delete-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  color: var(--vscode-foreground);
  background: transparent;
  font-size: var(--font-size-sm);
}

.shadow-delete-button:hover:not(:disabled) {
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
}

.shadow-delete-button:disabled {
  opacity: 0.45;
  cursor: default;
}

.shadow-delete-button svg {
  width: 15px;
  height: 15px;
}

.shadow-list-shell {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-editor-background);
}

.shadow-list-scroll {
  max-height: 320px;
  overflow-y: auto;
  scrollbar-width: none;
}

.shadow-list-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.shadow-empty {
  padding: var(--space-4);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  text-align: center;
}

.shadow-rows {
  display: flex;
  flex-direction: column;
}

.shadow-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
}

.shadow-row:last-child {
  border-bottom: 0;
}

.shadow-row.is-selected {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
}

.shadow-row-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.shadow-row-title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.shadow-row-detail {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.shadow-row-stats {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.shadow-stat {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  min-width: 0;
}

.shadow-stat em {
  font-style: normal;
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
}

.shadow-stat small {
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
}

.shadow-stat-time em {
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}
</style>
