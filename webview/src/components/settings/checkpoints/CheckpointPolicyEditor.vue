<script setup lang="ts">
import { computed } from 'vue';
import type { CheckpointPolicyRecord, CheckpointPolicyScopeKind, CheckpointToolTriggerConfigRecord, CheckpointTriggerConfigRecord, ToolDefinitionRecord } from '@shared/protocol';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { useCheckpointPolicyStore } from '@webview/stores/useCheckpointPolicyStore';
import { useToolPolicyStore } from '@webview/stores/useToolPolicyStore';

const props = withDefaults(defineProps<{
  scopeKind: CheckpointPolicyScopeKind;
  scopeId?: string;
  title?: string;
  description?: string;
  readonly?: boolean;
}>(), {
  title: '存档点策略',
  description: '',
  readonly: false
});

const store = useCheckpointPolicyStore();
const toolStore = useToolPolicyStore();
const localResolution = computed(() => store.localPolicyFor(props.scopeKind, props.scopeId));
const effectiveResolution = computed(() => store.effectivePolicyFor(props.scopeKind, props.scopeId));
const policy = computed(() => effectiveResolution.value.policy);
const tools = computed(() => toolStore.toolDefinitions);
const hasLocalOverride = computed(() => props.scopeKind === 'global' || !!localResolution.value.policy);
const canRestoreInheritance = computed(() => props.scopeKind !== 'global' && hasLocalOverride.value && !props.readonly);
const maxMb = computed(() => Math.max(1, Math.round((policy.value?.initialSnapshotMaxBytes ?? 0) / 1024 / 1024)));
const skipPatternText = computed(() => (policy.value?.skipPatterns ?? []).join('\n'));
const sourceLabel = computed(() => {
  if (props.scopeKind === 'global') return '全局默认策略';
  if (hasLocalOverride.value) return '当前作用域覆盖';
  return '继承全局默认策略';
});

const triggerOptions: Array<{ key: keyof CheckpointTriggerConfigRecord; label: string; description: string }> = [
  { key: 'conversationInitial', label: '首次用户消息前', description: '用户发送第一条消息时，先捕获对话开始前的项目状态。' },
  { key: 'userMessageBefore', label: '用户发消息前', description: '每次用户消息写入对话前创建存档点。' },
  { key: 'userMessageAfter', label: '用户发消息后', description: '用户消息实际写入对话后创建存档点。' },
  { key: 'llmResponseBefore', label: '每次调用 AI 前', description: '每次模型调用开始前创建存档点，默认关闭以避免重复。' },
  { key: 'llmResponseAfter', label: '每次调用 AI 后', description: '每次模型调用流式回复结束后触发，默认关闭以避免重复。' },
  { key: 'agentRunCompletedBefore', label: '整回合回复完成前', description: '整回合回复进入最终完成阶段前触发，默认关闭以避免重复。' },
  { key: 'agentRunCompletedAfter', label: '整回合回复完成后', description: '整回合回复完成交付后触发。' },
  { key: 'manual', label: '手动触发', description: '保留后续手动创建存档点入口。' }
];

const defaultTriggers: CheckpointTriggerConfigRecord = {
  conversationInitial: true,
  userMessageBefore: true,
  userMessageAfter: false,
  llmResponseBefore: false,
  llmResponseAfter: false,
  agentRunCompletedBefore: false,
  agentRunCompletedAfter: false,
  manual: true
};

function update(next: Partial<CheckpointPolicyRecord>): void {
  if (props.readonly) return;
  store.setPolicyForScope(props.scopeKind, props.scopeId, next);
}

function updateEnabled(value: boolean): void { update({ enabled: value }); }
function updatePreserveEmptyDirectories(value: boolean): void { update({ preserveEmptyDirectories: value }); }
function updateUseGitignore(value: boolean): void { update({ useGitignore: value }); }
function updateTrigger(key: keyof CheckpointTriggerConfigRecord, value: boolean): void {
  update({ triggers: { ...defaultTriggers, ...(policy.value?.triggers ?? {}), [key]: value } });
}
function toolTriggerConfig(tool: ToolDefinitionRecord): CheckpointToolTriggerConfigRecord {
  return normalizeToolTriggerConfig({ ...defaultToolTriggerConfig(tool), ...(policy.value?.toolTriggers?.[tool.name] ?? {}) });
}
function updateToolTrigger(tool: ToolDefinitionRecord, key: keyof CheckpointToolTriggerConfigRecord, value: boolean): void {
  update({ toolTriggers: { ...(policy.value?.toolTriggers ?? {}), [tool.name]: { ...toolTriggerConfig(tool), [key]: value } } });
}
function defaultToolTriggerConfig(tool: ToolDefinitionRecord): CheckpointToolTriggerConfigRecord {
  return normalizeToolTriggerConfig(tool.metadata?.checkpoint);
}
function normalizeToolTriggerConfig(input: Partial<CheckpointToolTriggerConfigRecord> | undefined): CheckpointToolTriggerConfigRecord {
  return {
    before: input?.before ?? true,
    after: input?.after ?? false
  };
}
function updateMaxMb(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  update({ initialSnapshotMaxBytes: Math.max(1, Math.floor(value)) * 1024 * 1024 });
}
function updateSkipPatterns(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value;
  update({ skipPatterns: value.split(/\r?\n/).filter((item) => item.trim()) });
}
function restoreInheritance(): void {
  if (!canRestoreInheritance.value) return;
  store.clearPolicyScope(props.scopeKind, props.scopeId);
}
</script>

<template>
  <section class="checkpoint-policy-editor" :aria-label="title">
    <header class="checkpoint-policy-header">
      <div>
        <h3>{{ title }}</h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <span class="checkpoint-source">{{ sourceLabel }}</span>
    </header>

    <div class="checkpoint-grid">
      <LcCheckbox :model-value="policy?.enabled" :readonly="readonly" @update:model-value="updateEnabled">
        <span class="checkbox-text">
          <strong>启用存档点</strong>
          <small>关闭后此作用域不会创建新的 shadow git 存档。</small>
        </span>
      </LcCheckbox>

      <LcCheckbox :model-value="policy?.preserveEmptyDirectories" :readonly="readonly" @update:model-value="updatePreserveEmptyDirectories">
        <span class="checkbox-text">
          <strong>保留空目录层级</strong>
          <small>在 shadow 仓库写入内部 manifest，不修改真实项目。</small>
        </span>
      </LcCheckbox>

      <LcCheckbox :model-value="policy?.useGitignore" :readonly="readonly" @update:model-value="updateUseGitignore">
        <span class="checkbox-text">
          <strong>使用项目 .gitignore</strong>
          <small>使用系统 Git 的 ignore 语义；已进入 shadow 仓库跟踪的文件不会因后续 ignore 规则自动移除。</small>
        </span>
      </LcCheckbox>
    </div>

    <label class="global-settings-field">
      <span>初始存档大小上限（MB）</span>
      <input type="number" min="1" :value="maxMb" :readonly="readonly" @change="updateMaxMb" />
    </label>

    <label class="global-settings-field global-settings-field-wide">
      <span>额外 Git ignore 规则（每行一条）</span>
      <textarea :value="skipPatternText" :readonly="readonly" rows="5" spellcheck="false" placeholder="node_modules/&#10;dist/**&#10;*.log&#10;!dist/keep.log" @change="updateSkipPatterns"></textarea>
    </label>

    <div class="trigger-section">
      <h4>触发事件</h4>
      <div class="trigger-list">
        <LcCheckbox
          v-for="item in triggerOptions"
          :key="item.key"
          :model-value="policy?.triggers[item.key]"
          :readonly="readonly"
          @update:model-value="(value) => updateTrigger(item.key, value)"
        >
          <span class="checkbox-text">
            <strong>{{ item.label }}</strong>
            <small>{{ item.description }}</small>
          </span>
        </LcCheckbox>
      </div>
    </div>

    <div class="tool-trigger-section">
      <header class="tool-trigger-header">
        <div>
          <h4>工具存档策略</h4>
          <p>按具体工具决定是否在执行前 / 执行后创建存档点；未列出的新工具默认只勾选执行前。</p>
        </div>
      </header>

      <div class="tool-trigger-list" role="list">
        <div class="tool-trigger-list-head" aria-hidden="true">
          <span>工具</span>
          <span>执行前</span>
          <span>执行后</span>
        </div>
        <div v-if="tools.length === 0" class="tool-trigger-empty">等待后端返回工具定义...</div>
        <div
          v-for="tool in tools"
          :key="tool.name"
          class="tool-trigger-row"
          role="listitem"
        >
          <div class="tool-trigger-info">
            <strong>{{ tool.name }}</strong>
          </div>
          <LcCheckbox
            class="tool-trigger-check"
            :model-value="toolTriggerConfig(tool).before"
            :readonly="readonly"
            aria-label="执行前创建存档点"
            @update:model-value="(value) => updateToolTrigger(tool, 'before', value)"
          />
          <LcCheckbox
            class="tool-trigger-check"
            :model-value="toolTriggerConfig(tool).after"
            :readonly="readonly"
            aria-label="执行后创建存档点"
            @update:model-value="(value) => updateToolTrigger(tool, 'after', value)"
          />
        </div>
      </div>
    </div>

    <button v-if="canRestoreInheritance" type="button" class="secondary" @click="restoreInheritance">
      恢复继承全局策略
    </button>
  </section>
</template>

<style scoped>
.checkpoint-policy-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-foreground) 5%);
}

.checkpoint-policy-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  align-items: flex-start;
}

.checkpoint-policy-header h3,
.trigger-section h4,
.tool-trigger-header h4 {
  margin: 0;
  font-size: var(--font-size-md);
}

.checkpoint-policy-header p {
  margin: var(--space-1) 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.checkpoint-source {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  font-size: var(--font-size-xs);
}

.checkpoint-grid,
.trigger-list {
  display: grid;
  gap: var(--space-2);
}

.checkbox-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.checkbox-text small {
  color: var(--vscode-descriptionForeground);
}

input,
textarea {
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  padding: var(--space-2);
}

input[type='number'] {
  appearance: textfield;
  -moz-appearance: textfield;
}

input[type='number']::-webkit-inner-spin-button,
input[type='number']::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

textarea {
  resize: vertical;
  min-height: 92px;
}

.trigger-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tool-trigger-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tool-trigger-header p {
  margin: var(--space-1) 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.tool-trigger-list {
  display: grid;
  gap: 1px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--vscode-panel-border);
}

.tool-trigger-list-head,
.tool-trigger-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 72px 72px;
  align-items: center;
  gap: var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  padding: var(--space-2);
}

.tool-trigger-list-head {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.tool-trigger-info {
  display: grid;
  min-width: 0;
}

.tool-trigger-info strong {
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}

.tool-trigger-empty {
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  color: var(--vscode-descriptionForeground);
  padding: var(--space-3);
}

.tool-trigger-check {
  justify-self: center;
}
</style>
