<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconListDetails, IconPencil, IconPlus, IconTrash } from '@tabler/icons-vue';
import type { ModeRecord } from '@shared/protocol';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import ToolPolicyEditor from '@webview/components/settings/tools/ToolPolicyEditor.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import { useModeStore } from '@webview/stores/useModeStore';

const modeStore = useModeStore();
const activeModeId = ref('');
const createOpen = ref(false);
const renameOpen = ref(false);
const deleteConfirmOpen = ref(false);

const modeOptions = computed<SettingsDropdownOption[]>(() =>
  modeStore.modes.map((mode) => ({
    value: mode.id,
    label: mode.name,
    description: mode.description || (mode.source === 'builtin' ? '内置模式' : '用户模式'),
    icon: IconListDetails
  }))
);
const activeMode = computed<ModeRecord | undefined>(() => modeStore.modes.find((mode) => mode.id === activeModeId.value));
const canDeleteActiveMode = computed(() => !!activeMode.value && activeMode.value.source !== 'builtin');
const activeModeKindLabel = computed(() => activeMode.value?.source === 'builtin' ? '内置模式' : '用户模式');
const deleteConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '删除' }
];
const deleteDescriptionHtml = computed(() => {
  const name = escapeHtml(activeMode.value?.name ?? '这个模式');
  return `确定删除「${name}」吗？关联的对话模式选择和模式级工具策略也会被清理，此操作<strong>无法撤销</strong>。`;
});

watch(
  () => modeStore.modes.map((mode) => mode.id).join('|'),
  () => {
    if (activeModeId.value && modeStore.modes.some((mode) => mode.id === activeModeId.value)) return;
    activeModeId.value = modeStore.planMode?.id ?? modeStore.modes[0]?.id ?? '';
  },
  { immediate: true }
);

function openCreate(): void { createOpen.value = true; }
function cancelCreate(): void { createOpen.value = false; }
function confirmCreate(name: string): void {
  createOpen.value = false;
  modeStore.createMode(name);
}

function openRename(): void {
  if (!activeMode.value) return;
  renameOpen.value = true;
}
function cancelRename(): void { renameOpen.value = false; }
function confirmRename(name: string): void {
  const mode = activeMode.value;
  renameOpen.value = false;
  if (!mode) return;
  modeStore.renameMode(mode.id, name);
}

function openDeleteConfirm(): void {
  if (!canDeleteActiveMode.value) return;
  deleteConfirmOpen.value = true;
}
function cancelDelete(): void { deleteConfirmOpen.value = false; }
function confirmDelete(): void {
  const mode = activeMode.value;
  deleteConfirmOpen.value = false;
  if (!mode) return;
  modeStore.deleteMode(mode.id);
}

function updateDescription(event: Event): void {
  const mode = activeMode.value;
  if (!mode) return;
  modeStore.updateModeDescription(mode.id, (event.target as HTMLTextAreaElement).value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
</script>

<template>
  <section class="global-settings-tab-section" aria-label="模式编辑">
    <header class="global-settings-section-header">
      <div>
        <h2>模式</h2>
        <p>管理内置模式和用户自定义模式。Global 是聊天里的合成选项，表示使用全局工具策略，不在这里作为模式编辑。</p>
      </div>
    </header>

    <div class="mode-editor-content">
      <div class="channel-config-picker">
        <label class="global-settings-field channel-config-select">
          <span>模式页</span>
          <SettingsDropdown
            v-model="activeModeId"
            :options="modeOptions"
            title="切换模式页"
            empty-text="暂无模式。"
            searchable
            search-placeholder="筛选模式..."
          />
        </label>

        <div class="channel-config-actions" aria-label="模式操作">
          <button type="button" class="icon-action" aria-label="新建模式" @click="openCreate">
            <IconPlus stroke="2" aria-hidden="true" />
          </button>
          <button type="button" class="icon-action" aria-label="重命名模式" :disabled="!activeMode" @click="openRename">
            <IconPencil stroke="2" aria-hidden="true" />
          </button>
          <button type="button" class="icon-action" aria-label="删除模式" :disabled="!canDeleteActiveMode" @click="openDeleteConfirm">
            <IconTrash stroke="2" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div v-if="activeMode" class="mode-summary-card">
        <span class="mode-summary-icon" aria-hidden="true"><IconListDetails stroke="2" /></span>
        <span class="mode-summary-main">
          <span class="mode-summary-title">{{ activeMode.name }}</span>
          <span class="mode-summary-desc">{{ activeMode.description || '暂无描述。' }}</span>
        </span>
        <span class="mode-summary-pill">{{ activeModeKindLabel }}</span>
      </div>

      <label v-if="activeMode" class="global-settings-field global-settings-field-wide mode-description-field">
        <span>模式描述</span>
        <textarea :value="activeMode.description ?? ''" rows="3" placeholder="描述这个模式的用途" @change="updateDescription"></textarea>
      </label>

      <ToolPolicyEditor
        v-if="activeMode"
        scope-kind="mode"
        :scope-id="activeMode.id"
        title="模式工具策略"
        description="这个模式启用时会优先使用这里的工具策略；未配置时继承全局策略。"
      />

      <div v-else class="global-settings-empty">等待后端返回模式列表...</div>

      <p class="global-settings-status">{{ modeStore.status }}</p>
    </div>

    <InputPanel
      :open="createOpen"
      title="新建模式"
      description="输入模式名称。创建后可在这里配置该模式的工具策略。"
      label="模式名称"
      placeholder="例如：Research"
      confirm-label="创建"
      @confirm="confirmCreate"
      @cancel="cancelCreate"
    />

    <InputPanel
      :open="renameOpen"
      title="重命名模式"
      description="输入新的模式名称。"
      label="模式名称"
      :initial-value="activeMode?.name ?? ''"
      placeholder="输入新的模式名称"
      confirm-label="保存"
      @confirm="confirmRename"
      @cancel="cancelRename"
    />

    <ConfirmPanel
      :open="deleteConfirmOpen"
      title="删除模式？"
      :description-html="deleteDescriptionHtml"
      :actions="deleteConfirmActions"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
.mode-editor-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.mode-summary-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.mode-summary-icon {
  width: 28px;
  height: 28px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
}

.mode-summary-icon svg {
  width: 16px;
  height: 16px;
}

.mode-summary-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mode-summary-title,
.mode-summary-desc {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mode-summary-title {
  font-weight: 600;
}

.mode-summary-desc {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.mode-summary-pill {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.mode-description-field textarea {
  width: 100%;
  min-height: 72px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
  resize: vertical;
}
</style>
