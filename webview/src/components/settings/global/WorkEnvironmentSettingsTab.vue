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
        <p>配置本地工作区与服务器工作环境，并设置全局默认工作环境策略。即使未启用工作环境切换工具，已允许的本地环境仍会作为路径访问边界并写入运行时上下文。</p>
      </div>
    </header>

    <WorkEnvironmentPolicyEditor
      scope-kind="global"
      title="全局默认工作环境策略"
      description="允许列表决定可访问的本地工作环境根目录；启用切换工具后还会出现在输入框工作环境下拉中。‘允许使用项目外路径’工具开关优先级最高，开启后不再受这些根目录限制。"
    />
  </section>
</template>
