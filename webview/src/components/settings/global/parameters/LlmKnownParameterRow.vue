<script setup lang="ts">
import { computed } from 'vue';
import { IconTrash } from '@tabler/icons-vue';
import SettingsDropdown, { type SettingsDropdownOption } from '../SettingsDropdown.vue';
import type { LlmParameterDefinition } from './llmParameterDefinitions';

const props = defineProps<{
  definition: LlmParameterDefinition;
  modelValue: unknown;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: unknown): void;
  (event: 'remove'): void;
}>();

const numberValue = computed(() => typeof props.modelValue === 'number' && Number.isFinite(props.modelValue) ? String(props.modelValue) : '');
const booleanValue = computed(() => props.modelValue === false ? 'false' : 'true');
const enumValue = computed(() => typeof props.modelValue === 'string' ? props.modelValue : String(props.definition.defaultValue ?? ''));
const booleanOptions: SettingsDropdownOption[] = [
  { value: 'true', label: 'True', description: '发送 true' },
  { value: 'false', label: 'False', description: '发送 false' }
];
const enumOptions = computed<SettingsDropdownOption[]>(() => (props.definition.options ?? []).map((option) => ({
  value: option.value,
  label: option.label,
  description: option.description
})));

function updateNumber(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim();
  if (!raw) {
    emit('update:modelValue', undefined);
    return;
  }
  const value = Number(raw);
  if (Number.isFinite(value)) emit('update:modelValue', value);
}

function updateBoolean(value: string): void {
  emit('update:modelValue', value === 'true');
}

function updateEnum(value: string): void {
  emit('update:modelValue', value);
}
</script>

<template>
  <article class="known-parameter-row">
    <div class="known-parameter-info">
      <span class="known-parameter-label">{{ definition.label }}</span>
      <span class="known-parameter-path">{{ definition.displayPath }}</span>
      <span class="known-parameter-description">{{ definition.description }}</span>
    </div>

    <div class="known-parameter-control">
      <input
        v-if="definition.valueType === 'number'"
        :value="numberValue"
        type="number"
        step="any"
        placeholder="输入数字"
        @input="updateNumber"
      />
      <SettingsDropdown
        v-else-if="definition.valueType === 'boolean'"
        :model-value="booleanValue"
        :options="booleanOptions"
        title="选择布尔值"
        @update:model-value="updateBoolean"
      />
      <SettingsDropdown
        v-else
        :model-value="enumValue"
        :options="enumOptions"
        title="选择等级"
        @update:model-value="updateEnum"
      />
    </div>

    <button type="button" class="known-parameter-remove" aria-label="移除参数" @click="emit('remove')">
      <IconTrash stroke="2" aria-hidden="true" />
    </button>
  </article>
</template>

<style scoped>
.known-parameter-row {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 220px) 26px;
  gap: var(--space-2);
  align-items: center;
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.known-parameter-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.known-parameter-label {
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.known-parameter-path,
.known-parameter-description {
  min-width: 0;
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.known-parameter-control {
  min-width: 0;
}

.known-parameter-control input {
  width: 100%;
  min-height: 30px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
}

.known-parameter-remove {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-sm);
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.known-parameter-remove:hover:not(:disabled),
.known-parameter-remove:focus-visible {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.known-parameter-remove svg {
  width: 14px;
  height: 14px;
}

@media (max-width: 680px) {
  .known-parameter-row {
    grid-template-columns: 1fr 26px;
  }

  .known-parameter-control {
    grid-column: 1 / -1;
    order: 3;
  }
}
</style>
