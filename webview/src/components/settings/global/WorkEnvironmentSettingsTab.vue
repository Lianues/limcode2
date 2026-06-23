<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import WorkEnvironmentPolicyEditor from '@webview/components/settings/workEnvironment/WorkEnvironmentPolicyEditor.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const { loading: workEnvironmentLoading, text: workEnvironmentLoadingText } = useSettingsLoadingText('工作环境配置', 'global');
</script>

<template>
  <section class="global-settings-tab-section" aria-label="工作环境配置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          工作环境
          <SettingsLoadingInline :show="workEnvironmentLoading" :text="workEnvironmentLoadingText" />
        </h2>
        <p>配置本地工作区与服务器工作环境，并设置全局默认工作环境策略。对话、模式等作用域可以继承或覆盖这里的策略。</p>
      </div>
    </header>

    <WorkEnvironmentPolicyEditor
      scope-kind="global"
      title="全局默认工作环境策略"
      description="全局允许的工作环境会出现在输入框工作环境下拉中；不同环境类型通过独立 provider 接入，服务器环境可从 VS Code SSH 配置导入或手动创建。"
    />
  </section>
</template>
