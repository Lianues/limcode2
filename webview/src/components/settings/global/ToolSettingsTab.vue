<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import ToolPolicyEditor from '@webview/components/settings/tools/ToolPolicyEditor.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const { loading: toolLoading, text: toolLoadingText } = useSettingsLoadingText('工具配置', 'global');
</script>

<template>
  <section class="global-settings-tab-section" aria-label="工具配置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          工具
          <SettingsLoadingInline :show="toolLoading" :text="toolLoadingText" />
        </h2>
        <p>工具定义由后端注册表只读提供；这里配置全局默认工具策略，聊天、Agent、Mode、Run 等作用域可在后续面板中继承或覆盖。</p>
      </div>
    </header>

    <ToolPolicyEditor
      scope-kind="global"
      title="全局默认工具策略"
      description="新对话或未单独设置工具策略的作用域会继承这里的启用状态。"
    />
  </section>
</template>
