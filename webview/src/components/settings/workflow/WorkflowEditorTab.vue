<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { IconPlus, IconTrash, IconDeviceFloppy, IconRefresh, IconListDetails } from '@tabler/icons-vue';
import type { WorkflowIconKey, WorkflowRecord } from '@shared/protocol';
import { useWorkflowStore, workflowRecordToPlain } from '@webview/stores/useWorkflowStore';
import AdvancedScrollbar from '../../navigation/AdvancedScrollbar.vue';
import ConfirmPanel from '../../ui/ConfirmPanel.vue';
import InputPanel from '../../ui/InputPanel.vue';

const workflowStore = useWorkflowStore();
const { workflows } = storeToRefs(workflowStore);

const selectedWorkflowId = ref('');
const rawText = ref('');
const rawError = ref('');
const rawStatus = ref('');
const createPanelOpen = ref(false);
const deleteConfirmOpen = ref(false);
const workflowListScroller = ref<HTMLElement | null>(null);

const selectedWorkflow = computed(() => workflows.value.find((workflow) => workflow.id === selectedWorkflowId.value) ?? workflows.value[0]);
const selectedPlainWorkflow = computed(() => selectedWorkflow.value ? workflowRecordToPlain(selectedWorkflow.value) : undefined);
const isDirty = computed(() => selectedPlainWorkflow.value !== undefined && rawText.value !== stringifyWorkflow(selectedPlainWorkflow.value));
const canDeleteSelected = computed(() => !!selectedWorkflow.value && selectedWorkflow.value.source === 'user');

watch(
  workflows,
  (items) => {
    if (items.length === 0) {
      selectedWorkflowId.value = '';
      rawText.value = '';
      return;
    }
    if (!items.some((workflow) => workflow.id === selectedWorkflowId.value)) {
      selectedWorkflowId.value = items[0]!.id;
    }
  },
  { immediate: true }
);

watch(
  selectedPlainWorkflow,
  (workflow) => {
    rawError.value = '';
    rawStatus.value = '';
    rawText.value = workflow ? stringifyWorkflow(workflow) : '';
  },
  { immediate: true }
);

function stringifyWorkflow(workflow: WorkflowRecord): string {
  return JSON.stringify(workflow, null, 2);
}

function selectWorkflow(workflowId: string): void {
  selectedWorkflowId.value = workflowId;
}

function parseWorkflowJson(): WorkflowRecord | undefined {
  rawError.value = '';
  rawStatus.value = '';
  const current = selectedPlainWorkflow.value;
  if (!current) {
    rawError.value = '请先选择一个工作流。';
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(rawText.value);
  } catch (error) {
    rawError.value = error instanceof Error ? `JSON 解析失败：${error.message}` : 'JSON 解析失败。';
    return undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    rawError.value = '工作流原始数据必须是 JSON object。';
    return undefined;
  }

  const record = value as Partial<WorkflowRecord>;
  if (record.id !== current.id) {
    rawError.value = '暂不支持通过原始数据修改工作流 id。';
    return undefined;
  }
  if (record.source !== current.source) {
    rawError.value = '暂不支持通过原始数据修改工作流 source。';
    return undefined;
  }
  if (typeof record.name !== 'string' || !record.name.trim()) {
    rawError.value = 'name 必须是非空字符串。';
    return undefined;
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    rawError.value = 'description 必须是字符串或省略。';
    return undefined;
  }
  if (record.icon !== undefined && record.icon !== 'list-details') {
    rawError.value = 'icon 当前只支持 "list-details"。';
    return undefined;
  }
  if (typeof record.createdAt !== 'number' || typeof record.updatedAt !== 'number') {
    rawError.value = 'createdAt / updatedAt 必须是 number。';
    return undefined;
  }

  return {
    ...current,
    name: record.name,
    ...(record.description?.trim() ? { description: record.description } : {}),
    source: current.source,
    icon: (record.icon ?? current.icon) as WorkflowIconKey | undefined,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt
  };
}

function saveRawWorkflow(): void {
  const parsed = parseWorkflowJson();
  if (!parsed) return;
  workflowStore.saveWorkflowRaw(parsed);
  rawStatus.value = '已提交保存。';
}

function resetRawWorkflow(): void {
  rawError.value = '';
  rawStatus.value = '';
  if (selectedPlainWorkflow.value) rawText.value = stringifyWorkflow(selectedPlainWorkflow.value);
}

function openCreatePanel(): void {
  createPanelOpen.value = true;
}

function confirmCreateWorkflow(name: string): void {
  createPanelOpen.value = false;
  workflowStore.createWorkflow(name);
}

function openDeleteConfirm(): void {
  if (!canDeleteSelected.value) return;
  deleteConfirmOpen.value = true;
}

function confirmDeleteWorkflow(): void {
  const workflow = selectedWorkflow.value;
  deleteConfirmOpen.value = false;
  if (!workflow) return;
  workflowStore.deleteWorkflow(workflow.id);
}
</script>

<template>
  <section class="workflow-editor-tab settings-tab-content">
    <header class="workflow-editor-head">
      <div>
        <p class="settings-kicker">Workflow</p>
        <h2>工作流编辑</h2>
        <p>暂时不做可视化表单；这里直接显示每个工作流的原始数据，方便后续扩展 Plan / Review / Read Only 等工作流。</p>
      </div>
      <button type="button" class="workflow-action-button" @click="openCreatePanel">
        <IconPlus :size="15" stroke="2.2" />
        <span>新建工作流</span>
      </button>
    </header>

    <div class="workflow-editor-layout">
      <aside class="workflow-list-panel" aria-label="工作流列表">
        <div class="workflow-list-title">工作流</div>
        <div ref="workflowListScroller" class="workflow-list-scroll">
          <button
            v-for="workflow in workflows"
            :key="workflow.id"
            type="button"
            class="workflow-list-item"
            :class="{ active: workflow.id === selectedWorkflow?.id }"
            @click="selectWorkflow(workflow.id)"
          >
            <span class="workflow-list-item-icon" aria-hidden="true"><IconListDetails :size="15" stroke="2.1" /></span>
            <span class="workflow-list-item-main">
              <span class="workflow-list-item-name">{{ workflow.name }}</span>
              <span class="workflow-list-item-id">{{ workflow.id }}</span>
            </span>
            <span class="workflow-source-pill">{{ workflow.source === 'builtin' ? '内置' : '用户' }}</span>
          </button>
        </div>
        <AdvancedScrollbar :scroller="workflowListScroller" variant="minimal" />
      </aside>

      <main class="workflow-raw-panel">
        <template v-if="selectedWorkflow">
          <div class="workflow-raw-head">
            <div>
              <div class="workflow-raw-title">{{ selectedWorkflow.name }}</div>
              <div class="workflow-raw-subtitle">{{ selectedWorkflow.id }} · {{ selectedWorkflow.source === 'builtin' ? '内置工作流' : '用户工作流' }}</div>
            </div>
            <div class="workflow-raw-actions">
              <button type="button" class="workflow-secondary-button" :disabled="!isDirty" @click="resetRawWorkflow">
                <IconRefresh :size="15" stroke="2.2" />
                <span>重置</span>
              </button>
              <button type="button" class="workflow-primary-button" :disabled="!isDirty" @click="saveRawWorkflow">
                <IconDeviceFloppy :size="15" stroke="2.2" />
                <span>保存</span>
              </button>
              <button type="button" class="workflow-danger-button" :disabled="!canDeleteSelected" @click="openDeleteConfirm">
                <IconTrash :size="15" stroke="2.2" />
                <span>删除</span>
              </button>
            </div>
          </div>

          <textarea
            v-model="rawText"
            class="workflow-json-editor"
            spellcheck="false"
            aria-label="工作流原始 JSON 数据"
          ></textarea>
          <p v-if="rawError" class="workflow-error">{{ rawError }}</p>
          <p v-else-if="rawStatus || workflowStore.status" class="workflow-status">{{ rawStatus || workflowStore.status }}</p>
          <p v-else class="workflow-help">当前原始编辑只允许修改 name / description / icon；id、source、createdAt、updatedAt 由系统维护。</p>
        </template>
        <div v-else class="workflow-empty">暂无工作流。</div>
      </main>
    </div>

    <InputPanel
      :open="createPanelOpen"
      title="新建工作流"
      description="创建后会出现在工作流列表中，可继续编辑原始数据。"
      label="工作流名称"
      placeholder="例如：Plan"
      confirm-label="创建"
      @confirm="confirmCreateWorkflow"
      @cancel="createPanelOpen = false"
    />

    <ConfirmPanel
      :open="deleteConfirmOpen"
      title="删除工作流"
      :description="`确定删除工作流「${selectedWorkflow?.name ?? ''}」吗？这个操作不会保留旧兼容。`"
      danger
      confirm-label="删除"
      @confirm="confirmDeleteWorkflow"
      @cancel="deleteConfirmOpen = false"
    />
  </section>
</template>

<style scoped>
.workflow-editor-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.workflow-editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.workflow-editor-head h2 {
  margin: 2px 0 4px;
  font-size: 17px;
  font-weight: 650;
  color: var(--vscode-foreground);
}

.workflow-editor-head p {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.6;
}

.workflow-editor-layout {
  display: grid;
  grid-template-columns: minmax(210px, 260px) minmax(0, 1fr);
  gap: 12px;
  min-height: 430px;
}

.workflow-list-panel,
.workflow-raw-panel {
  position: relative;
  border: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
  background: var(--vscode-editor-background);
}

.workflow-list-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.workflow-list-title {
  padding: 10px 12px 8px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: .04em;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
}

.workflow-list-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-width: none;
  padding: 6px;
}

.workflow-list-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.workflow-list-item {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--vscode-foreground);
  text-align: left;
  padding: 8px;
  cursor: pointer;
}

.workflow-list-item:hover,
.workflow-list-item.active {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-sideBar-border, var(--vscode-panel-border));
}

.workflow-list-item-icon,
.workflow-source-pill {
  color: var(--vscode-descriptionForeground);
}

.workflow-list-item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.workflow-list-item-name,
.workflow-list-item-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workflow-list-item-name {
  font-size: 12px;
  font-weight: 600;
}

.workflow-list-item-id {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.workflow-source-pill {
  border: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
  padding: 1px 5px;
  font-size: 10px;
}

.workflow-raw-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 12px;
  gap: 10px;
}

.workflow-raw-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.workflow-raw-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--vscode-foreground);
}

.workflow-raw-subtitle {
  margin-top: 2px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.workflow-raw-actions,
.workflow-action-button,
.workflow-secondary-button,
.workflow-primary-button,
.workflow-danger-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.workflow-raw-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.workflow-action-button,
.workflow-secondary-button,
.workflow-primary-button,
.workflow-danger-button {
  border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  padding: 5px 8px;
  font-size: 12px;
  cursor: pointer;
}

.workflow-action-button:hover,
.workflow-secondary-button:hover,
.workflow-primary-button:hover,
.workflow-danger-button:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
}

.workflow-primary-button {
  border-color: var(--vscode-focusBorder);
}

.workflow-danger-button {
  color: var(--vscode-errorForeground);
}

.workflow-action-button:disabled,
.workflow-secondary-button:disabled,
.workflow-primary-button:disabled,
.workflow-danger-button:disabled {
  opacity: .55;
  cursor: not-allowed;
}

.workflow-json-editor {
  flex: 1;
  min-height: 330px;
  width: 100%;
  resize: vertical;
  box-sizing: border-box;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  padding: 10px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  line-height: 1.55;
  outline: none;
}

.workflow-json-editor:focus {
  border-color: var(--vscode-focusBorder);
}

.workflow-error,
.workflow-status,
.workflow-help,
.workflow-empty {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}

.workflow-error {
  color: var(--vscode-errorForeground);
}

.workflow-status,
.workflow-help,
.workflow-empty {
  color: var(--vscode-descriptionForeground);
}

@media (max-width: 780px) {
  .workflow-editor-layout {
    grid-template-columns: 1fr;
  }
}
</style>
