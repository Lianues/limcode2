<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import RuntimeContextScopeEditor from '@webview/components/settings/config/RuntimeContextScopeEditor.vue';
import SystemPromptScopeEditor from '@webview/components/settings/config/SystemPromptScopeEditor.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const { loading: promptLoading, text: promptLoadingText } = useSettingsLoadingText('提示词配置', 'global');
</script>

<template>
  <section class="global-settings-tab-section" aria-label="提示词配置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          提示词
          <SettingsLoadingInline :show="promptLoading" :text="promptLoadingText" />
        </h2>
        <p>系统提示词用于稳定行为规则；运行时上下文用于初始变量快照，默认不会在每次请求时自动刷新。</p>
      </div>
    </header>

    <SystemPromptScopeEditor
      scope-kind="global"
      title="全局系统提示词"
      description="所有 Agent / Mode / Conversation 都会继承这里的稳定规则。可插入 Agent / Mode 这类稳定占位符。"
    />

    <RuntimeContextScopeEditor
      scope-kind="global"
      title="全局运行时上下文模板"
      description="用于生成对话运行时快照的默认模板。时间、工作环境等变量只在快照生成或刷新时替换一次。"
    />
  </section>
</template>
