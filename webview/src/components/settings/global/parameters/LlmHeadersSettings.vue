<script setup lang="ts">
import { computed } from 'vue';
import { IconPlus, IconTrash } from '@tabler/icons-vue';
import type { LlmProviderHeadersRecord } from '@shared/protocol';

const props = defineProps<{
  modelValue: LlmProviderHeadersRecord;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: LlmProviderHeadersRecord | undefined): void;
}>();

const entries = computed(() => Object.entries(props.modelValue ?? {}));

function emitHeaders(headers: LlmProviderHeadersRecord): void {
  emit('update:modelValue', Object.keys(headers).length > 0 ? headers : undefined);
}

function cloneHeaders(): LlmProviderHeadersRecord {
  return { ...(props.modelValue ?? {}) };
}

function addHeader(): void {
  const headers = cloneHeaders();
  headers[uniqueKey('X-Custom-Header', Object.keys(headers))] = '';
  emitHeaders(headers);
}

function removeHeader(key: string): void {
  const headers = cloneHeaders();
  delete headers[key];
  emitHeaders(headers);
}

function renameHeader(oldKey: string, event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim();
  if (!raw || raw === oldKey) return;
  const headers = cloneHeaders();
  const value = headers[oldKey] ?? '';
  delete headers[oldKey];
  headers[uniqueKey(raw, Object.keys(headers))] = value;
  emitHeaders(headers);
}

function updateHeaderValue(key: string, event: Event): void {
  const headers = cloneHeaders();
  headers[key] = (event.target as HTMLInputElement).value;
  emitHeaders(headers);
}

function uniqueKey(base: string, existingKeys: string[]): string {
  const normalized = base.trim() || 'X-Custom-Header';
  const existingLower = new Set(existingKeys.map((key) => key.toLowerCase()));
  if (!existingLower.has(normalized.toLowerCase())) return normalized;
  let index = 2;
  while (existingLower.has(`${normalized}-${index}`.toLowerCase())) index += 1;
  return `${normalized}-${index}`;
}
</script>

<template>
  <section class="llm-headers-settings" aria-label="自定义请求头">
    <header class="llm-headers-header">
      <div>
        <label>自定义请求头</label>
        <p>请求头值固定为字符串；同名 header 可能覆盖默认认证、版本或 User-Agent，请谨慎配置。</p>
      </div>
      <button type="button" class="llm-headers-add" @click="addHeader">
        <IconPlus stroke="2" aria-hidden="true" />
        <span>添加请求头</span>
      </button>
    </header>

    <div v-if="!entries.length" class="llm-headers-empty">暂无自定义请求头。</div>

    <div v-else class="llm-headers-list">
      <article v-for="[key, value] in entries" :key="key" class="llm-header-row">
        <input
          class="llm-header-name"
          :value="key"
          type="text"
          spellcheck="false"
          placeholder="Header 名称"
          @change="renameHeader(key, $event)"
        />
        <input
          class="llm-header-value"
          :value="value"
          type="text"
          spellcheck="false"
          placeholder="Header 值"
          @input="updateHeaderValue(key, $event)"
        />
        <button type="button" class="llm-header-remove" aria-label="移除请求头" @click="removeHeader(key)">
          <IconTrash stroke="2" aria-hidden="true" />
        </button>
      </article>
    </div>
  </section>
</template>

<style scoped>
.llm-headers-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.llm-headers-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}

.llm-headers-header label {
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.llm-headers-header p {
  margin: 2px 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.llm-headers-add {
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--vscode-foreground);
  background: transparent;
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.llm-headers-add:hover:not(:disabled),
.llm-headers-add:focus-visible,
.llm-header-remove:hover:not(:disabled),
.llm-header-remove:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.llm-headers-add svg,
.llm-header-remove svg {
  width: 14px;
  height: 14px;
}

.llm-headers-empty {
  border: 1px dashed var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.llm-headers-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.llm-header-row {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: grid;
  grid-template-columns: minmax(140px, 0.75fr) minmax(0, 1.25fr) 26px;
  gap: var(--space-2);
  align-items: center;
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.llm-header-name,
.llm-header-value {
  width: 100%;
  min-height: 30px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
}

.llm-header-remove {
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

@media (max-width: 680px) {
  .llm-headers-header {
    flex-direction: column;
  }

  .llm-header-row {
    grid-template-columns: 1fr 26px;
  }

  .llm-header-name,
  .llm-header-value {
    grid-column: 1 / -1;
  }
}
</style>
