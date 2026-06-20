<script setup lang="ts">
import { computed } from 'vue';
import type { CheckpointPolicyRecord, CheckpointPolicyScopeKind, CheckpointTriggerConfigRecord } from '@shared/protocol';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { useCheckpointPolicyStore } from '@webview/stores/useCheckpointPolicyStore';

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
const localResolution = computed(() => store.localPolicyFor(props.scopeKind, props.scopeId));
const effectiveResolution = computed(() => store.effectivePolicyFor(props.scopeKind, props.scopeId));
const policy = computed(() => effectiveResolution.value.policy);
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
  { key: 'userMessageAfter', label: '用户发消息后', description: '用户消息实际写入对话后创建存档点。' },
  { key: 'llmResponseAfter', label: 'AI 单轮回复后', description: '每次模型流式回复结束后触发，默认关闭以避免重复。' },
  { key: 'toolExecutionBefore', label: '工具执行前', description: '捕获工具可能修改文件前的状态。' },
  { key: 'toolExecutionAfter', label: '工具执行后', description: '工具结果写回对话后记录新状态。' },
  { key: 'agentRunCompletedAfter', label: 'AI 回复完成后', description: '整轮 AgentRun 完成交付后触发。' },
  { key: 'manual', label: '手动触发', description: '保留后续手动创建存档点入口。' }
];

const defaultTriggers: CheckpointTriggerConfigRecord = {
  conversationInitial: true,
  userMessageAfter: true,
  llmResponseAfter: false,
  toolExecutionBefore: true,
  toolExecutionAfter: true,
  agentRunCompletedAfter: true,
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
.trigger-section h4 {
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
</style>
