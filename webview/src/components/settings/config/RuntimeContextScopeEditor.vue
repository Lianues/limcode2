<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ConfigScopeKind } from '@shared/protocol';
import { stripInitialWorkEnvironmentSection } from '@shared/runtimeContextText';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useRuntimeContextStore } from '@webview/stores/useRuntimeContextStore';
import { useWorkEnvironmentStore } from '@webview/stores/useWorkEnvironmentStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const props = withDefaults(defineProps<{ scopeKind: ConfigScopeKind; scopeId?: string; title?: string; description?: string }>(), {
  title: '运行时上下文',
  description: ''
});

const store = useRuntimeContextStore();
const workEnvironment = useWorkEnvironmentStore();
const { loading: runtimeLoading, text: runtimeLoadingText } = useSettingsLoadingText('运行时上下文配置', () => props.scopeKind, () => props.scopeId);
const scroller = ref<HTMLTextAreaElement | null>(null);
const snapshotScroller = ref<HTMLElement | null>(null);
const draft = ref('');
const local = computed(() => store.localContextFor(props.scopeKind, props.scopeId));
const placeholders = computed(() => store.runtimePlaceholders);
const conversationSnapshot = computed(() => props.scopeKind === 'conversation' ? store.activeSnapshotForConversation(props.scopeId) : undefined);
const conversationSnapshotText = computed(() => {
  const text = conversationSnapshot.value?.text ?? '';
  return workEnvironment.workEnvironmentEnabledForConversation(props.scopeId ?? '')
    ? text
    : stripInitialWorkEnvironmentSection(text);
});

watch(() => [props.scopeKind, props.scopeId, local.value.runtimeContext?.id], () => {
  draft.value = local.value.runtimeContext?.template ?? '';
}, { immediate: true });

function save(): void { store.setContextForScope(props.scopeKind, props.scopeId, draft.value, `${props.scopeKind} Runtime Context`); }
function clear(): void { draft.value = ''; store.clearContextScope(props.scopeKind, props.scopeId); }
function refreshSnapshot(): void { if (props.scopeKind === 'conversation') store.refreshConversationSnapshot(props.scopeId); }
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
  <section class="runtime-editor">
    <header class="runtime-editor-header">
      <div>
        <h3>
          {{ title }}
          <SettingsLoadingInline :show="runtimeLoading" :text="runtimeLoadingText" />
        </h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <span>{{ local.runtimeContext ? '当前作用域已配置' : scopeKind === 'global' ? '等待默认模板' : '继承上级模板' }}</span>
    </header>

    <div class="runtime-hint">
      这里编辑的是运行时快照模板：固定文本会保留，变量占位符只在生成/刷新快照时替换一次。模型请求默认读取已生成快照，不会每次自动同步当前时间或环境。
    </div>

    <div class="runtime-shell">
      <div v-if="placeholders.length > 0" class="placeholder-bar" aria-label="可插入运行时变量占位符">
        <button v-for="placeholder in placeholders" :key="placeholder.id" type="button" class="placeholder-chip" @click="insertPlaceholder(placeholder.token)">
          <span>{{ placeholder.token }}</span>
          <small>{{ placeholder.label }}</small>
        </button>
      </div>
      <textarea ref="scroller" v-model="draft" rows="8" placeholder="输入运行时快照模板，例如 Initial time: {{$runtime.timestamp}}"></textarea>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </div>

    <div class="runtime-actions">
      <button type="button" :disabled="!draft.trim()" @click="save">保存模板</button>
      <button type="button" class="secondary" :disabled="scopeKind === 'global' || !local.runtimeContext" @click="clear">恢复继承</button>
      <button v-if="scopeKind === 'conversation'" type="button" class="secondary" :disabled="!scopeId" @click="refreshSnapshot">刷新快照</button>
      <span>{{ store.status }}</span>
    </div>

    <article v-if="scopeKind === 'conversation'" class="snapshot-card">
      <header>
        <strong>当前对话快照</strong>
        <span v-if="conversationSnapshot">{{ new Date(conversationSnapshot.refreshedAt).toLocaleString() }}</span>
        <span v-else>尚未生成；下次模型请求前会初始化。</span>
      </header>
      <div v-if="conversationSnapshot" class="snapshot-body-shell">
        <pre ref="snapshotScroller">{{ conversationSnapshotText }}</pre>
        <AdvancedScrollbar :scroller="snapshotScroller" variant="minimal" />
      </div>
    </article>
  </section>
</template>

<style scoped>
.runtime-editor { display: flex; flex-direction: column; gap: var(--space-2); }
.runtime-editor-header { display: flex; justify-content: space-between; gap: var(--space-3); color: var(--vscode-descriptionForeground); }
h3 { margin: 0; color: var(--vscode-foreground); font-size: var(--font-size-md); }
p { margin: 2px 0 0; font-size: var(--font-size-sm); }
.runtime-hint { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding: var(--space-2); color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%); font-size: var(--font-size-sm); }
.runtime-shell { position: relative; min-height: 130px; }
.placeholder-bar { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-2); }
.placeholder-chip { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%); color: var(--vscode-foreground); display: inline-flex; align-items: center; gap: 6px; padding: 3px 7px; font: inherit; }
.placeholder-chip small { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.placeholder-chip:hover,
.placeholder-chip:focus-visible { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%)); outline: none; }
textarea { width: 100%; min-height: 130px; box-sizing: border-box; resize: vertical; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: var(--space-2); font: inherit; scrollbar-width: none; }
textarea::-webkit-scrollbar { display: none; }
.runtime-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.runtime-actions button { min-height: 28px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); color: var(--vscode-foreground); background: transparent; }
.runtime-actions button:hover:not(:disabled),
.runtime-actions button:focus-visible,
.runtime-actions button:active { border-color: var(--vscode-panel-border); background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%)); outline: none; }
.runtime-actions button.secondary { color: var(--vscode-descriptionForeground); }
.runtime-actions button:disabled { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); background: transparent; opacity: 0.55; }
.snapshot-card { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding: var(--space-2); display: flex; flex-direction: column; gap: var(--space-2); background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%); }
.snapshot-card header { display: flex; justify-content: space-between; gap: var(--space-2); color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.snapshot-card strong { color: var(--vscode-foreground); }
.snapshot-body-shell { position: relative; max-height: 180px; }
pre { margin: 0; max-height: 180px; overflow: auto; white-space: pre-wrap; font: inherit; color: var(--vscode-descriptionForeground); scrollbar-width: none; }
pre::-webkit-scrollbar { display: none; }
</style>
