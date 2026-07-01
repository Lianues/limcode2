<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import RulesEditor from '@webview/components/settings/rules/RulesEditor.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const { loading: rulesLoading, text: rulesLoadingText } = useSettingsLoadingText('规则配置', 'global');
</script>

<template>
  <section class="global-settings-tab-section" aria-label="规则配置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          规则
          <SettingsLoadingInline :show="rulesLoading" :text="rulesLoadingText" />
        </h2>
        <p>规则来自项目根与数据根的 AGENTS.md / CLAUDE.md，在对话开始时冻结注入 runtime 提示词，对所有 Agent 生效。AGENTS.md 由此处维护，CLAUDE.md 仅作兼容只读读取（用户自行修改文件）。</p>
      </div>
    </header>

    <RulesEditor />
  </section>
</template>
