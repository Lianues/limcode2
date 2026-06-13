<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolDefinitionRecord, ToolPolicyScopeKind } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import { useToolPolicyStore } from '@webview/stores/useToolPolicyStore';

const props = withDefaults(defineProps<{
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
  title?: string;
  description?: string;
  readonly?: boolean;
}>(), {
  title: '工具策略',
  description: '',
  readonly: false
});

const store = useToolPolicyStore();
const scroller = ref<HTMLElement | null>(null);

const tools = computed(() => store.toolDefinitions);
const localResolution = computed(() => store.localPolicyFor(props.scopeKind, props.scopeId));
const effectiveResolution = computed(() => store.effectivePolicyFor(props.scopeKind, props.scopeId));
const effectivePolicy = computed(() => effectiveResolution.value.policy);
const hasLocalOverride = computed(() => props.scopeKind === 'global' || !!localResolution.value.policy);
const allowedSet = computed(() => new Set(effectivePolicy.value?.allowedTools ?? []));
const enabledCount = computed(() => tools.value.filter((tool) => allowedSet.value.has(tool.name)).length);
const canRestoreInheritance = computed(() => props.scopeKind !== 'global' && hasLocalOverride.value && !props.readonly);
const sourceLabel = computed(() => {
  if (props.scopeKind === 'global') return '全局默认策略';
  if (hasLocalOverride.value) return '当前作用域覆盖';
  const inheritedFrom = effectiveResolution.value.inheritedFrom;
  if (inheritedFrom === 'modeLegacy') return '继承模式策略';
  if (inheritedFrom === 'runLegacy') return '继承运行策略';
  return '继承全局默认策略';
});

function nextAllowed(toolName: string, enabled: boolean): string[] {
  const names = new Set(effectivePolicy.value?.allowedTools ?? []);
  if (enabled) names.add(toolName);
  else names.delete(toolName);
  return tools.value.map((tool) => tool.name).filter((name) => names.has(name));
}

function toggleTool(tool: ToolDefinitionRecord): void {
  if (props.readonly) return;
  store.setPolicyForScope(props.scopeKind, props.scopeId, nextAllowed(tool.name, !allowedSet.value.has(tool.name)), effectivePolicy.value?.name);
}

function enableAll(): void {
  if (props.readonly) return;
  store.setPolicyForScope(props.scopeKind, props.scopeId, tools.value.map((tool) => tool.name), effectivePolicy.value?.name);
}

function disableAll(): void {
  if (props.readonly) return;
  store.setPolicyForScope(props.scopeKind, props.scopeId, [], effectivePolicy.value?.name);
}

function restoreInheritance(): void {
  if (!canRestoreInheritance.value) return;
  store.clearPolicyScope(props.scopeKind, props.scopeId);
}

function riskLabel(tool: ToolDefinitionRecord): string {
  switch (tool.metadata?.riskLevel) {
    case 'read': return '只读';
    case 'write': return '写入';
    case 'command': return '命令';
    case 'agent': return 'Agent';
    default: return '未分类';
  }
}

function executionLabel(tool: ToolDefinitionRecord): string {
  return tool.execution === 'agentRun' ? 'AgentRun' : 'Runtime';
}

function toolDescription(tool: ToolDefinitionRecord): string {
  return tool.description || '后端未提供描述。';
}
</script>

<template>
  <section class="tool-policy-editor" :aria-label="title">
    <header class="tool-policy-header">
      <div class="tool-policy-title-block">
        <h3>{{ title }}</h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <div class="tool-policy-summary" aria-live="polite">
        <span>{{ sourceLabel }}</span>
        <span>{{ enabledCount }} / {{ tools.length }} 已启用</span>
      </div>
    </header>

    <div class="tool-policy-actions">
      <button type="button" :disabled="readonly || tools.length === 0" @click="enableAll">启用全部</button>
      <button type="button" class="secondary" :disabled="readonly || tools.length === 0" @click="disableAll">禁用全部</button>
      <button type="button" class="secondary" :disabled="!canRestoreInheritance" @click="restoreInheritance">恢复继承</button>
    </div>

    <div class="tool-list-shell">
      <div ref="scroller" class="tool-list-scroll">
        <div v-if="tools.length === 0" class="tool-list-empty">等待后端返回工具定义...</div>
        <template v-else>
          <button
            v-for="tool in tools"
            :key="tool.name"
            type="button"
            class="tool-item"
            :class="{ 'is-enabled': allowedSet.has(tool.name) }"
            :disabled="readonly"
            @click="toggleTool(tool)"
          >
            <span class="tool-toggle" aria-hidden="true"></span>
            <span class="tool-main">
              <span class="tool-name-row">
                <span class="tool-name">{{ tool.name }}</span>
                <span class="tool-pill">{{ executionLabel(tool) }}</span>
                <span class="tool-pill">{{ riskLabel(tool) }}</span>
              </span>
              <span class="tool-description">{{ toolDescription(tool) }}</span>
            </span>
          </button>
        </template>
      </div>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </div>
  </section>
</template>

<style scoped>
.tool-policy-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.tool-policy-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: flex-start;
  flex-wrap: wrap;
}

.tool-policy-title-block h3 {
  margin: 0;
  font-size: var(--font-size-md);
}

.tool-policy-title-block p {
  margin: var(--space-1) 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.tool-policy-summary {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.tool-policy-summary span {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.tool-policy-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.tool-policy-actions button {
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
}

.tool-policy-actions button:hover:not(:disabled),
.tool-policy-actions button:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.tool-policy-actions button:disabled {
  opacity: 0.45;
}

.tool-list-shell {
  position: relative;
  min-height: 220px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.tool-list-scroll {
  max-height: 420px;
  overflow-y: auto;
  scrollbar-width: none;
}

.tool-list-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.tool-list-empty {
  padding: var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.tool-item {
  width: 100%;
  min-height: 64px;
  border: 0;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding: var(--space-2) var(--space-3);
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.tool-item:last-child {
  border-bottom: 0;
}

.tool-item:hover:not(:disabled),
.tool-item:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.tool-item.is-enabled {
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}

.tool-toggle {
  width: 10px;
  height: 10px;
  border: 1px solid var(--vscode-descriptionForeground);
  border-radius: 50%;
  justify-self: center;
}

.tool-item.is-enabled .tool-toggle {
  border-color: var(--vscode-foreground);
  background: var(--vscode-foreground);
}

.tool-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool-name-row {
  min-width: 0;
  display: flex;
  gap: var(--space-1);
  align-items: center;
  flex-wrap: wrap;
}

.tool-name {
  font-family: var(--vscode-editor-font-family, monospace);
  font-weight: 600;
}

.tool-pill {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 1px var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.tool-description {
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
