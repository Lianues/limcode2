<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { RuleScope } from '@shared/protocol';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useRulesStore } from '@webview/stores/useRulesStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const store = useRulesStore();
const { loading: rulesLoading, text: rulesLoadingText } = useSettingsLoadingText('规则配置', 'global');

const RULE_SCOPES: readonly RuleScope[] = ['global', 'project'];
const SCOPE_META: Record<RuleScope, { label: string; agentsHint: string; claudeHint: string }> = {
  global: {
    label: '全局规则',
    agentsHint: '数据根 <dataRoot>/AGENTS.md，所有项目共享。',
    claudeHint: '数据根 <dataRoot>/CLAUDE.md（兼容只读）。'
  },
  project: {
    label: '项目规则',
    agentsHint: '当前项目根 AGENTS.md，仅本项目生效。',
    claudeHint: '当前项目根 CLAUDE.md（兼容只读）。'
  }
};

/** 每个作用域的 AGENTS 草稿，以及“上一次已知的落盘基线”。基线用于判断草稿是否被用户改动。 */
const drafts = reactive<Record<RuleScope, string>>({ global: '', project: '' });
const baselines = reactive<Record<RuleScope, string>>({ global: '', project: '' });
const savingScope = ref<RuleScope | null>(null);

const agentsFileFor = (scope: RuleScope) => store.fileFor(scope, 'AGENTS');
const claudeFileFor = (scope: RuleScope) => store.fileFor(scope, 'CLAUDE');

// 初始化草稿与基线。
RULE_SCOPES.forEach((scope) => {
  const content = agentsFileFor(scope)?.content ?? '';
  drafts[scope] = content;
  baselines[scope] = content;
});

// 后端回流（保存成功或磁盘刷新）后，若用户未在该作用域改动草稿，则同步到最新落盘内容；否则保留正在编辑的草稿。
watch(
  () => RULE_SCOPES.map((scope) => agentsFileFor(scope)?.content ?? ''),
  (contents) => {
    RULE_SCOPES.forEach((scope, index) => {
      const saved = contents[index];
      if (saved === baselines[scope]) return;
      if (drafts[scope] === baselines[scope]) drafts[scope] = saved; // 未改动 → 跟随落盘更新
      baselines[scope] = saved;
    });
  }
);

const scopes = computed(() => RULE_SCOPES.map((scope) => {
  const agents = agentsFileFor(scope);
  const claude = claudeFileFor(scope);
  const available = !!agents; // project 无工作区时 agents 缺失 → 不可用
  return {
    scope,
    label: SCOPE_META[scope].label,
    agentsHint: SCOPE_META[scope].agentsHint,
    claudeHint: SCOPE_META[scope].claudeHint,
    available,
    agentsPath: agents?.path ?? '',
    agentsExists: agents?.exists ?? false,
    dirty: available && drafts[scope] !== baselines[scope],
    claude
  };
}));

function save(scope: RuleScope): void {
  savingScope.value = scope;
  store.save(scope, drafts[scope]);
  window.setTimeout(() => { if (savingScope.value === scope) savingScope.value = null; }, 800);
}

function reset(scope: RuleScope): void {
  drafts[scope] = baselines[scope];
}
</script>

<template>
  <section class="rules-editor" aria-label="规则配置">
    <header class="rules-editor-header">
      <div>
        <h3>
          规则文件
          <SettingsLoadingInline :show="rulesLoading" :text="rulesLoadingText" />
        </h3>
        <p>规则在对话开始时冻结注入到 runtime 提示词，对所有 Agent 生效；对话进行中修改需新开对话才生效。AGENTS.md 由此处维护，CLAUDE.md 仅作兼容只读预览。</p>
      </div>
      <button type="button" class="secondary" @click="store.refresh()">刷新</button>
    </header>

    <section v-for="item in scopes" :key="item.scope" class="rules-scope" aria-label="规则作用域">
      <div class="rules-scope-heading">
        <h4>{{ item.label }}</h4>
      </div>

      <div class="rules-block">
        <div class="rules-block-head">
          <span class="rules-block-title">AGENTS.md</span>
          <span class="rules-block-meta">
            {{ item.agentsHint }}
            <template v-if="item.available"> · {{ item.agentsExists ? '已存在' : '未创建（保存后创建）' }}</template>
            <template v-else> · 未打开工作区，不可用</template>
          </span>
        </div>
        <textarea
          v-model="drafts[item.scope]"
          rows="8"
          spellcheck="false"
          :disabled="!item.available"
          :placeholder="item.available ? '输入规则内容（Markdown），保存后写入 AGENTS.md' : '未打开工作区'"
        ></textarea>
        <div class="rules-block-actions">
          <button type="button" :disabled="!item.available || !item.dirty" @click="save(item.scope)">
            {{ savingScope === item.scope ? '保存中…' : '保存' }}
          </button>
          <button type="button" class="secondary" :disabled="!item.available || !item.dirty" @click="reset(item.scope)">撤销修改</button>
          <span v-if="item.dirty" class="rules-dirty">未保存</span>
        </div>
      </div>

      <div class="rules-block is-readonly">
        <div class="rules-block-head">
          <span class="rules-block-title">CLAUDE.md<small>只读</small></span>
          <span class="rules-block-meta">{{ item.claudeHint }}</span>
        </div>
        <div v-if="item.claude?.exists && item.claude.content.trim()" class="rules-preview-shell">
          <pre>{{ item.claude.content }}</pre>
        </div>
        <p v-else class="rules-preview-empty">未创建 CLAUDE.md。如需兼容读取，请手动在对应目录创建该文件。</p>
      </div>
    </section>
  </section>
</template>

<style scoped>
.rules-editor { display: flex; flex-direction: column; gap: var(--space-3); }
.rules-editor-header { display: flex; justify-content: space-between; gap: var(--space-3); align-items: flex-start; }
.rules-editor-header h3 { margin: 0; color: var(--vscode-foreground); font-size: var(--font-size-md); }
.rules-editor-header p { margin: 2px 0 0; color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); line-height: 1.5; }
.rules-editor-header button { flex-shrink: 0; white-space: nowrap; min-height: 28px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); color: var(--vscode-descriptionForeground); background: transparent; font: inherit; padding: 0 var(--space-2); }
.rules-editor-header button:hover:not(:disabled),
.rules-editor-header button:focus-visible { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%)); outline: none; }

.rules-scope { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-3); background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%); }
.rules-scope-heading h4 { margin: 0; font-size: var(--font-size-md); }

.rules-block { display: flex; flex-direction: column; gap: var(--space-2); }
.rules-block-head { display: flex; flex-direction: column; gap: 2px; }
.rules-block-title { font-family: var(--vscode-editor-font-family, monospace); font-weight: 650; display: inline-flex; align-items: center; gap: 6px; }
.rules-block-title small { font-family: inherit; font-weight: 500; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding: 0 4px; font-size: var(--font-size-xs); }
.rules-block-meta { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); line-height: 1.4; }

textarea { width: 100%; min-height: 150px; box-sizing: border-box; resize: vertical; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: var(--space-2); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--font-size-sm); scrollbar-width: none; }
textarea::-webkit-scrollbar { display: none; }
textarea:disabled { opacity: 0.55; }

.rules-block-actions { display: flex; align-items: center; gap: var(--space-2); }
.rules-block-actions button { min-height: 28px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); color: var(--vscode-foreground); background: transparent; font: inherit; padding: 0 var(--space-2); }
.rules-block-actions button.secondary { color: var(--vscode-descriptionForeground); }
.rules-block-actions button:hover:not(:disabled),
.rules-block-actions button:focus-visible { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%)); outline: none; }
.rules-block-actions button:disabled { opacity: 0.45; }
.rules-dirty { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }

.rules-block.is-readonly { border-top: 1px dashed var(--vscode-panel-border); padding-top: var(--space-3); }
.rules-preview-shell { position: relative; max-height: 200px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); overflow: hidden; background: var(--vscode-editor-background); }
pre { margin: 0; max-height: 200px; overflow: auto; white-space: pre-wrap; padding: var(--space-2); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--font-size-sm); color: var(--vscode-descriptionForeground); scrollbar-width: none; }
pre::-webkit-scrollbar { display: none; }
.rules-preview-empty { margin: 0; color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); font-style: italic; }
</style>
