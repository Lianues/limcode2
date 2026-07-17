<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconListDetails, IconPencil, IconPlus, IconTrash } from '@tabler/icons-vue';
import type { ModeRecord } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import ToolPolicyEditor from '@webview/components/settings/tools/ToolPolicyEditor.vue';
import SkillPolicyEditor from '@webview/components/settings/skills/SkillPolicyEditor.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import WorkEnvironmentPolicyEditor from '@webview/components/settings/workEnvironment/WorkEnvironmentPolicyEditor.vue';
import CheckpointPolicyEditor from '@webview/components/settings/checkpoints/CheckpointPolicyEditor.vue';
import { useModeStore } from '@webview/stores/useModeStore';
import SystemPromptScopeEditor from '@webview/components/settings/config/SystemPromptScopeEditor.vue';
import RuntimeContextScopeEditor from '@webview/components/settings/config/RuntimeContextScopeEditor.vue';
import ModelProfileScopeEditor from '@webview/components/settings/config/ModelProfileScopeEditor.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const modeStore = useModeStore();
const { loading: modeLoading, text: modeLoadingText } = useSettingsLoadingText('工作流配置');
const activeModeId = ref('');
const createOpen = ref(false);
const renameOpen = ref(false);
const deleteConfirmOpen = ref(false);
const modeDescriptionScroller = ref<HTMLElement | null>(null);

const modeOptions = computed<SettingsDropdownOption[]>(() =>
  modeStore.modes.map((mode) => ({
    value: mode.id,
    label: mode.name,
    description: mode.description || (mode.source === 'builtin' ? '内置工作流' : '用户工作流'),
    icon: IconListDetails
  }))
);
const activeMode = computed<ModeRecord | undefined>(() => modeStore.modes.find((mode) => mode.id === activeModeId.value));
const canDeleteActiveMode = computed(() => !!activeMode.value && activeMode.value.source !== 'builtin');
const activeModeKindLabel = computed(() => activeMode.value?.source === 'builtin' ? '内置工作流' : '用户工作流');
const deleteConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '删除' }
];
const deleteDescriptionHtml = computed(() => {
  const name = escapeHtml(activeMode.value?.name ?? '这个工作流');
  return `确定删除「${name}」吗？关联的对话工作流选择和工作流级工具策略也会被清理，此操作<strong>无法撤销</strong>。`;
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
  modeStore.updateModeDescription(mode.id, editableText(event));
}

function editableText(event: Event): string { return (event.currentTarget as HTMLElement | null)?.textContent ?? ''; }

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
  <section class="global-settings-tab-section" aria-label="工作流编辑">
    <header class="global-settings-section-header">
      <div>
        <h2>
          工作流
          <SettingsLoadingInline :show="modeLoading" :text="modeLoadingText" />
        </h2>
        <p>管理内置工作流和用户自定义工作流。默认是聊天里的合成选项，表示使用全局工具策略，不在这里作为工作流编辑。</p>
      </div>
    </header>

    <div class="mode-editor-content">
      <div class="channel-config-picker">
        <label class="global-settings-field channel-config-select">
          <span>工作流页</span>
          <SettingsDropdown
            v-model="activeModeId"
            :options="modeOptions"
            title="切换工作流页"
            empty-text="暂无工作流。"
            searchable
            search-placeholder="筛选工作流..."
          />
        </label>

        <div class="channel-config-actions" aria-label="工作流操作">
          <button type="button" class="icon-action" aria-label="新建工作流" @click="openCreate">
            <IconPlus stroke="2" aria-hidden="true" />
          </button>
          <button type="button" class="icon-action" aria-label="重命名工作流" :disabled="!activeMode" @click="openRename">
            <IconPencil stroke="2" aria-hidden="true" />
          </button>
          <button type="button" class="icon-action" aria-label="删除工作流" :disabled="!canDeleteActiveMode" @click="openDeleteConfirm">
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
        <span>工作流描述</span>
        <div class="mode-description-shell">
          <div
            :key="activeMode.id"
            ref="modeDescriptionScroller"
            class="mode-description-editor"
            contenteditable="plaintext-only"
            role="textbox"
            aria-multiline="true"
            data-placeholder="描述这个工作流的用途"
            @blur="updateDescription"
          >{{ activeMode.description ?? '' }}</div>
          <AdvancedScrollbar :scroller="modeDescriptionScroller" :refresh-key="activeMode.id" variant="minimal" />
        </div>
      </label>

      <SystemPromptScopeEditor
        v-if="activeMode"
        scope-kind="mode"
        :scope-id="activeMode.id"
        title="工作流行为 Prompt"
        description="按 global → agent → workflow → conversation → run 顺序拼接。这里定义这个工作流的行为段。"
      />

      <ModelProfileScopeEditor
        v-if="activeMode"
        scope-kind="mode"
        :scope-id="activeMode.id"
        title="工作流模型覆盖"
        description="当这个工作流被选中时，优先覆盖 Agent 默认模型；Run/Conversation 仍可覆盖它。"
      />

      <RuntimeContextScopeEditor
        v-if="activeMode"
        scope-kind="mode"
        :scope-id="activeMode.id"
        title="工作流运行时上下文模板"
        description="用于生成运行时快照的工作流级模板；变量只在快照生成或刷新时替换一次。"
      />

      <WorkEnvironmentPolicyEditor
        v-if="activeMode"
        scope-kind="mode"
        :scope-id="activeMode.id"
        title="工作流工作环境策略"
        description="这个工作流启用时会优先使用这里的工作环境策略；未配置时继承全局策略。"
      />

      <ToolPolicyEditor
        v-if="activeMode"
        scope-kind="mode"
        :scope-id="activeMode.id"
        title="工作流工具策略"
        description="这个工作流启用时会优先使用这里的工具策略；未配置时继承全局策略。"
      />

      <SkillPolicyEditor
        v-if="activeMode"
        scope-kind="mode"
        :scope-id="activeMode.id"
        title="工作流技能策略"
        description="这个工作流启用时会优先使用这里的技能策略；未配置时继承全局策略。"
      />

      <CheckpointPolicyEditor
        v-if="activeMode"
        scope-kind="mode"
        :scope-id="activeMode.id"
        title="工作流存档点策略"
        description="这个工作流启用时会优先使用这里的存档点策略；未配置时继承全局策略。"
      />

      <div v-else class="global-settings-empty">等待后端返回工作流列表...</div>

      <p class="global-settings-status">{{ modeStore.status }}</p>
    </div>

    <InputPanel
      :open="createOpen"
      title="新建工作流"
      description="输入工作流名称。创建后可在这里配置该工作流的工具策略。"
      label="工作流名称"
      placeholder="例如：Research"
      confirm-label="创建"
      @confirm="confirmCreate"
      @cancel="cancelCreate"
    />

    <InputPanel
      :open="renameOpen"
      title="重命名工作流"
      description="输入新的工作流名称。"
      label="工作流名称"
      :initial-value="activeMode?.name ?? ''"
      placeholder="输入新的工作流名称"
      confirm-label="保存"
      @confirm="confirmRename"
      @cancel="cancelRename"
    />

    <ConfirmPanel
      :open="deleteConfirmOpen"
      title="删除工作流？"
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

.mode-description-shell {
  position: relative;
  overflow: hidden;
}

.mode-description-editor {
  width: 100%;
  height: 86px;
  overflow-y: auto;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: var(--space-2) calc(var(--space-2) + 10px) var(--space-2) var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: none;
}

.mode-description-editor::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.mode-description-editor:empty::before {
  content: attr(data-placeholder);
  color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
  pointer-events: none;
}

.mode-description-editor:focus {
  border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
}
</style>
