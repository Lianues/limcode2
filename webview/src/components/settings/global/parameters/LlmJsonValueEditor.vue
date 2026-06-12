<script setup lang="ts">
import { computed } from 'vue';
import { IconPlus, IconTrash } from '@tabler/icons-vue';
import type { LlmRequestBodyJsonValue, LlmRequestBodyRecord } from '@shared/protocol';
import SettingsDropdown, { type SettingsDropdownOption } from '../SettingsDropdown.vue';

defineOptions({ name: 'LlmJsonValueEditor' });

type JsonValueType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

const props = withDefaults(
  defineProps<{
    modelValue: LlmRequestBodyJsonValue;
    level?: number;
    rootObject?: boolean;
  }>(),
  {
    level: 0,
    rootObject: false
  }
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: LlmRequestBodyJsonValue): void;
}>();

const typeOptions: SettingsDropdownOption[] = [
  { value: 'string', label: '字符串' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'null', label: '空值' },
  { value: 'object', label: '对象' },
  { value: 'array', label: '数组' }
];
const booleanOptions: SettingsDropdownOption[] = [
  { value: 'true', label: 'True' },
  { value: 'false', label: 'False' }
];

const currentType = computed<JsonValueType>(() => props.rootObject ? 'object' : valueType(props.modelValue));
const objectEntries = computed(() => Object.entries(valueAsRecord(props.modelValue)));
const arrayItems = computed(() => valueAsArray(props.modelValue));
const isNested = computed(() => props.level > 0);

function updateType(type: string): void {
  emit('update:modelValue', defaultValueForType(type as JsonValueType));
}

function updateString(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}

function updateNumber(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim();
  const value = Number(raw);
  emit('update:modelValue', raw && Number.isFinite(value) ? value : 0);
}

function updateBoolean(value: string): void {
  emit('update:modelValue', value === 'true');
}

function addObjectField(): void {
  const record = cloneRecord(valueAsRecord(props.modelValue));
  record[uniqueKey('custom_param', Object.keys(record))] = '';
  emit('update:modelValue', record);
}

function removeObjectField(key: string): void {
  const record = cloneRecord(valueAsRecord(props.modelValue));
  delete record[key];
  emit('update:modelValue', record);
}

function renameObjectField(oldKey: string, event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim();
  if (!raw || raw === oldKey) return;
  const record = cloneRecord(valueAsRecord(props.modelValue));
  const value = record[oldKey];
  delete record[oldKey];
  record[uniqueKey(raw, Object.keys(record))] = value ?? '';
  emit('update:modelValue', record);
}

function updateObjectFieldValue(key: string, value: LlmRequestBodyJsonValue): void {
  const record = cloneRecord(valueAsRecord(props.modelValue));
  record[key] = cloneValue(value);
  emit('update:modelValue', record);
}

function addArrayItem(): void {
  emit('update:modelValue', [...valueAsArray(props.modelValue).map(cloneValue), '']);
}

function removeArrayItem(index: number): void {
  const items = valueAsArray(props.modelValue).map(cloneValue);
  items.splice(index, 1);
  emit('update:modelValue', items);
}

function updateArrayItem(index: number, value: LlmRequestBodyJsonValue): void {
  const items = valueAsArray(props.modelValue).map(cloneValue);
  items[index] = cloneValue(value);
  emit('update:modelValue', items);
}

function valueType(value: LlmRequestBodyJsonValue): JsonValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (isJsonObject(value)) return 'object';
  return 'string';
}

function valueAsString(value: LlmRequestBodyJsonValue): string {
  return typeof value === 'string' ? value : '';
}

function valueAsNumber(value: LlmRequestBodyJsonValue): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '0';
}

function valueAsBoolean(value: LlmRequestBodyJsonValue): string {
  return value === false ? 'false' : 'true';
}

function valueAsRecord(value: LlmRequestBodyJsonValue): LlmRequestBodyRecord {
  return isJsonObject(value) ? cloneRecord(value) : {};
}

function valueAsArray(value: LlmRequestBodyJsonValue): LlmRequestBodyJsonValue[] {
  return Array.isArray(value) ? value.map(cloneValue) : [];
}

function defaultValueForType(type: JsonValueType): LlmRequestBodyJsonValue {
  if (type === 'number') return 0;
  if (type === 'boolean') return true;
  if (type === 'null') return null;
  if (type === 'object') return {};
  if (type === 'array') return [];
  return '';
}

function uniqueKey(base: string, existingKeys: string[]): string {
  const normalized = base.trim() || 'custom_param';
  const existing = new Set(existingKeys);
  if (!existing.has(normalized)) return normalized;
  let index = 2;
  while (existing.has(`${normalized}_${index}`)) index += 1;
  return `${normalized}_${index}`;
}

function cloneValue(value: LlmRequestBodyJsonValue): LlmRequestBodyJsonValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isJsonObject(value)) return cloneRecord(value);
  return value;
}

function cloneRecord(record: LlmRequestBodyRecord): LlmRequestBodyRecord {
  const next: LlmRequestBodyRecord = {};
  for (const [key, value] of Object.entries(record)) {
    next[key] = cloneValue(value);
  }
  return next;
}

function isJsonObject(value: unknown): value is LlmRequestBodyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
</script>

<template>
  <div class="json-value-editor" :class="{ nested: isNested, root: rootObject }">
    <div v-if="!rootObject" class="json-value-inline">
      <div class="json-value-type">
        <SettingsDropdown
          :model-value="currentType"
          :options="typeOptions"
          title="选择 JSON 值类型"
          @update:model-value="updateType"
        />
      </div>

      <input
        v-if="currentType === 'string'"
        class="json-value-input"
        :value="valueAsString(modelValue)"
        type="text"
        spellcheck="false"
        placeholder="字符串值"
        @input="updateString"
      />
      <input
        v-else-if="currentType === 'number'"
        class="json-value-input"
        :value="valueAsNumber(modelValue)"
        type="number"
        step="any"
        placeholder="数字值"
        @input="updateNumber"
      />
      <div v-else-if="currentType === 'boolean'" class="json-value-control">
        <SettingsDropdown
          :model-value="valueAsBoolean(modelValue)"
          :options="booleanOptions"
          title="选择布尔值"
          @update:model-value="updateBoolean"
        />
      </div>
      <code v-else-if="currentType === 'null'" class="json-null-value">null</code>
    </div>

    <div v-if="currentType === 'object'" class="json-container json-object-container">
      <header class="json-container-header">
        <span>{{ rootObject ? '自定义参数 · requestBody' : '对象字段' }}</span>
        <button type="button" class="json-container-add" @click="addObjectField">
          <IconPlus stroke="2" aria-hidden="true" />
          <span>添加字段</span>
        </button>
      </header>

      <div v-if="!objectEntries.length" class="json-container-empty">空对象。</div>
      <div v-else class="json-object-rows">
        <article v-for="[key, value] in objectEntries" :key="key" class="json-object-row">
          <input class="json-object-key" :value="key" spellcheck="false" @change="renameObjectField(key, $event)" />
          <LlmJsonValueEditor
            class="json-object-value"
            :model-value="value"
            :level="level + 1"
            @update:model-value="updateObjectFieldValue(key, $event)"
          />
          <button type="button" class="json-row-remove" aria-label="移除字段" @click="removeObjectField(key)">
            <IconTrash stroke="2" aria-hidden="true" />
          </button>
        </article>
      </div>
    </div>

    <div v-if="currentType === 'array'" class="json-container json-array-container">
      <header class="json-container-header">
        <span>数组项</span>
        <button type="button" class="json-container-add" @click="addArrayItem">
          <IconPlus stroke="2" aria-hidden="true" />
          <span>添加项</span>
        </button>
      </header>

      <div v-if="!arrayItems.length" class="json-container-empty">空数组。</div>
      <div v-else class="json-array-rows">
        <article v-for="(item, index) in arrayItems" :key="index" class="json-array-row">
          <span class="json-array-index">#{{ index + 1 }}</span>
          <LlmJsonValueEditor
            class="json-array-value"
            :model-value="item"
            :level="level + 1"
            @update:model-value="updateArrayItem(index, $event)"
          />
          <button type="button" class="json-row-remove" aria-label="移除数组项" @click="removeArrayItem(index)">
            <IconTrash stroke="2" aria-hidden="true" />
          </button>
        </article>
      </div>
    </div>
  </div>
</template>

<style scoped>
.json-value-editor {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.json-value-editor.nested {
  border-color: color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
}

.json-value-inline,
.json-object-row,
.json-array-row {
  min-width: 0;
  display: grid;
  grid-template-columns: 130px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: start;
}

.json-value-type,
.json-value-control,
.json-object-value,
.json-array-value {
  min-width: 0;
}

.json-value-input,
.json-object-key {
  width: 100%;
  min-height: 30px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
}

.json-null-value {
  min-height: 30px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: inline-flex;
  align-items: center;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.json-container {
  border: 1px dashed var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 98%, var(--vscode-foreground) 2%);
}

.json-value-editor.root > .json-container {
  border-style: solid;
  background: transparent;
}

.json-container-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.json-container-add {
  min-height: 26px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--vscode-foreground);
  background: transparent;
  font-size: var(--font-size-xs);
}

.json-container-add:hover:not(:disabled),
.json-container-add:focus-visible,
.json-row-remove:hover:not(:disabled),
.json-row-remove:focus-visible {
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.json-container-add svg,
.json-row-remove svg {
  width: 14px;
  height: 14px;
}

.json-container-empty {
  padding: var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.json-object-rows,
.json-array-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.json-object-row {
  grid-template-columns: minmax(100px, 0.42fr) minmax(0, 1fr) 26px;
}

.json-array-row {
  grid-template-columns: 34px minmax(0, 1fr) 26px;
}

.json-array-index {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.json-row-remove {
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

@media (max-width: 720px) {
  .json-value-inline,
  .json-object-row,
  .json-array-row {
    grid-template-columns: 1fr 26px;
  }

  .json-value-type,
  .json-value-input,
  .json-value-control,
  .json-null-value,
  .json-object-value,
  .json-array-value {
    grid-column: 1 / -1;
  }
}
</style>
