<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ConfigScopeKind } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import { useSystemPromptStore } from '@webview/stores/useSystemPromptStore';

const props = withDefaults(defineProps<{ scopeKind: ConfigScopeKind; scopeId?: string; title?: string; description?: string }>(), {
  title: 'System Prompt',
  description: ''
});

const store = useSystemPromptStore();
const scroller = ref<HTMLTextAreaElement | null>(null);
const draft = ref('');
const local = computed(() => store.localPromptFor(props.scopeKind, props.scopeId));
const placeholders = computed(() => store.systemPlaceholders);

watch(() => [props.scopeKind, props.scopeId, local.value.prompt?.id], () => {
  draft.value = local.value.prompt?.text ?? '';
}, { immediate: true });

function save(): void { store.setPromptForScope(props.scopeKind, props.scopeId, draft.value, `${props.scopeKind} System Prompt`); }
function clear(): void { draft.value = ''; store.clearPromptScope(props.scopeKind, props.scopeId); }
function insertPlaceholder(token: string): void {
  const textarea = scroller.value;
  if (!textarea) {
    draft.value += token;
    return;
  }
  const start = textarea.selectionStart ?? draft.value.length;
  const end = textarea.selectionEnd ?? start;
  draft.value = `${draft.value.slice(0, start)}${token}${draft.value.slice(end)}`;
  void nextTick(() => {
    textarea.focus();
    const nextPosition = start + token.length;
    textarea.setSelectionRange(nextPosition, nextPosition);
  });
}
</script>

<template>
  <section class="scope-editor">
    <header class="scope-editor-header">
      <div>
        <h3>{{ title }}</h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <span>{{ local.prompt ? '当前作用域已配置' : '未配置' }}</span>
    </header>
    <div class="prompt-shell">
      <div v-if="placeholders.length > 0" class="placeholder-bar" aria-label="可插入系统提示词占位符">
        <button v-for="placeholder in placeholders" :key="placeholder.id" type="button" class="placeholder-chip" @click="insertPlaceholder(placeholder.token)">
          <span>{{ placeholder.token }}</span>
          <small>{{ placeholder.label }}</small>
        </button>
      </div>
      <textarea ref="scroller" v-model="draft" rows="8" placeholder="输入这个作用域要追加的 system prompt..."></textarea>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </div>
    <div class="scope-editor-actions">
      <button type="button" @click="save">保存 Prompt</button>
      <button type="button" class="secondary" :disabled="scopeKind === 'global' || !local.prompt" @click="clear">恢复继承</button>
      <span>{{ store.status }}</span>
    </div>
  </section>
</template>

<style scoped>
.scope-editor { display: flex; flex-direction: column; gap: var(--space-2); }
.scope-editor-header { display: flex; justify-content: space-between; gap: var(--space-3); color: var(--vscode-descriptionForeground); }
h3 { margin: 0; color: var(--vscode-foreground); font-size: var(--font-size-md); }
p { margin: 2px 0 0; font-size: var(--font-size-sm); }
.prompt-shell { position: relative; min-height: 130px; }
.placeholder-bar { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-2); }
.placeholder-chip { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%); color: var(--vscode-foreground); display: inline-flex; align-items: center; gap: 6px; padding: 3px 7px; font: inherit; }
.placeholder-chip small { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.placeholder-chip:hover,
.placeholder-chip:focus-visible { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%)); outline: none; }
textarea { width: 100%; min-height: 130px; box-sizing: border-box; resize: vertical; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: var(--space-2); font: inherit; scrollbar-width: none; }
textarea::-webkit-scrollbar { display: none; }
.scope-editor-actions { display: flex; align-items: center; gap: var(--space-2); color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.scope-editor-actions button {
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
}
.scope-editor-actions button:hover:not(:disabled),
.scope-editor-actions button:focus-visible,
.scope-editor-actions button:active {
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}
.scope-editor-actions button.secondary {
  color: var(--vscode-descriptionForeground);
}
.scope-editor-actions button:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  opacity: 0.55;
}
</style>
