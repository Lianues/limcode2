<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconRobot, IconPencil, IconPlus, IconTrash } from '@tabler/icons-vue';
import type { AgentRecord } from '@shared/protocol';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import ToolPolicyEditor from '@webview/components/settings/tools/ToolPolicyEditor.vue';
import WorkEnvironmentPolicyEditor from '@webview/components/settings/workEnvironment/WorkEnvironmentPolicyEditor.vue';
import CheckpointPolicyEditor from '@webview/components/settings/checkpoints/CheckpointPolicyEditor.vue';
import SystemPromptScopeEditor from '@webview/components/settings/config/SystemPromptScopeEditor.vue';
import RuntimeContextScopeEditor from '@webview/components/settings/config/RuntimeContextScopeEditor.vue';
import ModelProfileScopeEditor from '@webview/components/settings/config/ModelProfileScopeEditor.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import { useAgentStore } from '@webview/stores/useAgentStore';

const agentStore = useAgentStore();
const activeAgentId = ref('');
const createOpen = ref(false);
const renameOpen = ref(false);
const deleteOpen = ref(false);
const options = computed<SettingsDropdownOption[]>(() => agentStore.agents.map((agent) => ({ value: agent.id, label: agent.name, description: agent.description || (agent.source === 'builtin' ? `内置 Agent · ${agent.kind}` : `用户 Agent · ${agent.kind}`), icon: IconRobot })));
const activeAgent = computed<AgentRecord | undefined>(() => agentStore.agents.find((agent) => agent.id === activeAgentId.value));
const canDelete = computed(() => activeAgent.value?.source === 'user');
const deleteActions: ConfirmPanelAction[] = [{ key: 'cancel', label: '取消', variant: 'secondary' }, { key: 'confirm', label: '删除' }];

watch(() => agentStore.agents.map((agent) => agent.id).join('|'), () => {
  if (activeAgentId.value && agentStore.agents.some((agent) => agent.id === activeAgentId.value)) return;
  activeAgentId.value = agentStore.agents.find((agent) => agent.id === 'main')?.id ?? agentStore.agents[0]?.id ?? '';
}, { immediate: true });

function updateDescription(event: Event): void { if (activeAgent.value) agentStore.updateDescription(activeAgent.value.id, (event.currentTarget as HTMLElement).textContent ?? ''); }
function confirmCreate(name: string): void { createOpen.value = false; agentStore.createAgent(name); }
function confirmRename(name: string): void { const agent = activeAgent.value; renameOpen.value = false; if (agent) agentStore.renameAgent(agent.id, name); }
function confirmDelete(): void { const agent = activeAgent.value; deleteOpen.value = false; if (agent) agentStore.deleteAgent(agent.id); }
</script>

<template>
  <section class="global-settings-tab-section agent-editor" aria-label="Agent 编辑">
    <header class="global-settings-section-header">
      <div>
        <h2>Agent</h2>
        <p>Agent 是角色层（who）：人格 Prompt、能力上限和默认模型。Mode 是独立的交互模式层（how）。</p>
      </div>
    </header>

    <div class="agent-picker-row">
      <label class="global-settings-field agent-picker">
        <span>Agent</span>
        <SettingsDropdown v-model="activeAgentId" :options="options" title="切换 Agent" searchable search-placeholder="筛选 Agent..." />
      </label>
      <div class="agent-actions">
        <button type="button" class="icon-action" aria-label="新建 Agent" @click="createOpen = true"><IconPlus stroke="2" /></button>
        <button type="button" class="icon-action" aria-label="重命名 Agent" :disabled="!activeAgent" @click="renameOpen = true"><IconPencil stroke="2" /></button>
        <button type="button" class="icon-action" aria-label="删除 Agent" :disabled="!canDelete" @click="deleteOpen = true"><IconTrash stroke="2" /></button>
      </div>
    </div>

    <div v-if="activeAgent" class="agent-summary-card">
      <span class="agent-icon"><IconRobot stroke="2" /></span>
      <span class="agent-main">
        <span class="agent-title">{{ activeAgent.name }}</span>
        <span class="agent-desc">{{ activeAgent.description || '暂无描述。' }}</span>
      </span>
      <span class="agent-pill">{{ activeAgent.source === 'builtin' ? '内置' : '用户' }}</span>
    </div>

    <label v-if="activeAgent" class="global-settings-field global-settings-field-wide">
      <span>Agent 描述</span>
      <div class="agent-description" contenteditable="plaintext-only" data-placeholder="描述这个 Agent 的用途" @blur="updateDescription">{{ activeAgent.description ?? '' }}</div>
    </label>

    <SystemPromptScopeEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 人格 Prompt" description="按 global → agent → mode → conversation → run 顺序拼接。这里定义这个 Agent 的角色人格。" />
    <RuntimeContextScopeEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 运行时上下文模板" description="用于生成运行时快照的 Agent 级模板；变量只在快照生成或刷新时替换一次。" />
    <ModelProfileScopeEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 默认模型" description="当 conversation/mode/run 没有更近覆盖时使用。" />
    <ToolPolicyEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 工具能力上限" description="Agent 的工具策略作为能力上限，Mode/Conversation/Run 只能继续收窄，不能放大。" />
    <WorkEnvironmentPolicyEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 工作环境策略" description="限制这个 Agent 可使用的工作环境。" />
    <CheckpointPolicyEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 存档点策略" description="限制这个 Agent 触发存档点的时机和 shadow 仓库过滤规则。" />

    <p class="global-settings-status">{{ agentStore.status }}</p>

    <InputPanel :open="createOpen" title="新建 Agent" description="输入 Agent 名称。创建后可配置 prompt、模型和工具能力。" label="Agent 名称" placeholder="例如：Docs Agent" confirm-label="创建" @confirm="confirmCreate" @cancel="createOpen = false" />
    <InputPanel :open="renameOpen" title="重命名 Agent" label="Agent 名称" :initial-value="activeAgent?.name ?? ''" confirm-label="保存" @confirm="confirmRename" @cancel="renameOpen = false" />
    <ConfirmPanel :open="deleteOpen" title="删除 Agent？" description-html="确定删除这个用户 Agent 及其作用域配置吗？此操作无法撤销。" :actions="deleteActions" @confirm="confirmDelete" @cancel="deleteOpen = false" />
  </section>
</template>

<style scoped>
.agent-editor { display: flex; flex-direction: column; gap: var(--space-4); }
.agent-picker-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); align-items: end; }
.agent-actions { display: flex; gap: var(--space-1); }
.agent-summary-card { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding: var(--space-3); display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: var(--space-2); align-items: center; background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%); }
.agent-icon { width: 28px; height: 28px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); display: inline-flex; align-items: center; justify-content: center; }
.agent-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.agent-title { font-weight: 600; }
.agent-desc { color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.agent-pill { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding: 2px var(--space-2); color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.agent-description { min-height: 56px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); padding: var(--space-2); background: var(--vscode-input-background); color: var(--vscode-input-foreground); outline: none; white-space: pre-wrap; }
</style>
