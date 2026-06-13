<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  ToolConfigFieldRecord,
  ToolConfigRecord,
  ToolConfigValue,
  ToolDefinitionRecord,
  ToolPolicyScopeKind,
  ToolPolicyToolConfigRecord
} from '@shared/protocol';
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
  store.setPolicyForScope(props.scopeKind, props.scopeId, nextAllowed(tool.name, !allowedSet.value.has(tool.name)), effectivePolicy.value?.name, cloneToolConfigs());
}

function enableAll(): void {
  if (props.readonly) return;
  store.setPolicyForScope(props.scopeKind, props.scopeId, tools.value.map((tool) => tool.name), effectivePolicy.value?.name, cloneToolConfigs());
}

function disableAll(): void {
  if (props.readonly) return;
  store.setPolicyForScope(props.scopeKind, props.scopeId, [], effectivePolicy.value?.name, cloneToolConfigs());
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

function cloneToolConfigs(): Record<string, ToolPolicyToolConfigRecord> {
  const result: Record<string, ToolPolicyToolConfigRecord> = {};
  for (const [toolName, record] of Object.entries(effectivePolicy.value?.toolConfigs ?? {})) {
    result[toolName] = { config: { ...(record.config ?? {}) } };
  }
  return result;
}

function configForTool(tool: ToolDefinitionRecord): ToolConfigRecord {
  return {
    ...(tool.defaultConfig ?? {}),
    ...(effectivePolicy.value?.toolConfigs?.[tool.name]?.config ?? {})
  };
}

function fieldListText(tool: ToolDefinitionRecord, field: ToolConfigFieldRecord): string {
  const value = configForTool(tool)[field.key];
  if (Array.isArray(value)) return value.map((item) => String(item)).join('\n');
  if (typeof value === 'string') return value;
  return '';
}

function updateStringListField(tool: ToolDefinitionRecord, field: ToolConfigFieldRecord, value: string): void {
  if (props.readonly) return;
  const current = configForTool(tool);
  const config = sanitizeConfigForTool(tool, {
    ...current,
    [field.key]: value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
  });
  const nextConfigs = cloneToolConfigs();
  nextConfigs[tool.name] = { config };
  store.setPolicyForScope(props.scopeKind, props.scopeId, effectivePolicy.value?.allowedTools ?? [], effectivePolicy.value?.name, nextConfigs);
}

function updateScalarField(tool: ToolDefinitionRecord, field: ToolConfigFieldRecord, value: ToolConfigValue): void {
  if (props.readonly) return;
  const config = sanitizeConfigForTool(tool, { ...configForTool(tool), [field.key]: value });
  const nextConfigs = cloneToolConfigs();
  nextConfigs[tool.name] = { config };
  store.setPolicyForScope(props.scopeKind, props.scopeId, effectivePolicy.value?.allowedTools ?? [], effectivePolicy.value?.name, nextConfigs);
}

function sanitizeConfigForTool(tool: ToolDefinitionRecord, config: ToolConfigRecord): ToolConfigRecord {
  const allowedKeys = new Set((tool.configSchema?.fields ?? []).map((field) => field.key));
  if (allowedKeys.size === 0) return {};
  const result: ToolConfigRecord = {};
  for (const [key, value] of Object.entries(config)) {
    if (allowedKeys.has(key)) result[key] = value;
  }
  return result;
}

function supportsInlineField(field: ToolConfigFieldRecord): boolean {
  return field.type === 'stringList' || field.type === 'globList' || field.type === 'string' || field.type === 'number' || field.type === 'boolean';
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
}

function inputNumber(event: Event): number {
  const value = Number((event.target as HTMLInputElement).value);
  return Number.isFinite(value) ? value : 0;
}

function inputChecked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked;
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
          <article v-for="tool in tools" :key="tool.name" class="tool-item" :class="{ 'is-enabled': allowedSet.has(tool.name) }">
            <button type="button" class="tool-item-main" :disabled="readonly" @click="toggleTool(tool)">
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

            <div v-if="allowedSet.has(tool.name) && tool.configSchema?.fields?.length" class="tool-config-panel">
              <label v-for="field in tool.configSchema.fields.filter(supportsInlineField)" :key="field.key" class="tool-config-field">
                <span>{{ field.label }}</span>
                <textarea
                  v-if="field.type === 'stringList' || field.type === 'globList'"
                  :value="fieldListText(tool, field)"
                  :placeholder="field.placeholder"
                  :readonly="readonly"
                  rows="3"
                  @change="updateStringListField(tool, field, inputValue($event))"
                ></textarea>
                <input
                  v-else-if="field.type === 'number'"
                  :value="configForTool(tool)[field.key] ?? field.defaultValue ?? 0"
                  :readonly="readonly"
                  type="number"
                  @change="updateScalarField(tool, field, inputNumber($event))"
                />
                <input
                  v-else-if="field.type === 'boolean'"
                  :checked="Boolean(configForTool(tool)[field.key] ?? field.defaultValue)"
                  :disabled="readonly"
                  type="checkbox"
                  @change="updateScalarField(tool, field, inputChecked($event))"
                />
                <input
                  v-else
                  :value="String(configForTool(tool)[field.key] ?? field.defaultValue ?? '')"
                  :readonly="readonly"
                  type="text"
                  @change="updateScalarField(tool, field, inputValue($event))"
                />
                <small v-if="field.description">{{ field.description }}</small>
              </label>
            </div>
          </article>
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
  max-height: 520px;
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
  border-bottom: 1px solid var(--vscode-panel-border);
  background: transparent;
}

.tool-item:last-child {
  border-bottom: 0;
}

.tool-item.is-enabled {
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.tool-item-main {
  width: 100%;
  min-height: 64px;
  border: 0;
  padding: var(--space-2) var(--space-3);
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.tool-item-main:hover:not(:disabled),
.tool-item-main:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
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

.tool-config-panel {
  padding: 0 var(--space-3) var(--space-3) calc(var(--space-3) + 28px);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.tool-config-field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.tool-config-field > span {
  color: var(--vscode-foreground);
  font-weight: 600;
}

.tool-config-field textarea,
.tool-config-field input[type='text'],
.tool-config-field input[type='number'] {
  width: 100%;
  min-height: 30px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
}

.tool-config-field textarea {
  resize: vertical;
  min-height: 72px;
  font-family: var(--vscode-editor-font-family, monospace);
}

.tool-config-field small {
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}

@media (max-width: 720px) {
  .tool-config-panel {
    grid-template-columns: 1fr;
  }
}
</style>
