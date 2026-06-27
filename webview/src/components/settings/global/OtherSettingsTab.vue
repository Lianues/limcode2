<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const settings = useGlobalSettingsStore();
const { loading: otherLoading, text: otherLoadingText } = useSettingsLoadingText('其他设置', 'global', undefined, { globalSettingsSections: ['common'] as const });
</script>

<template>
  <section class="global-settings-tab-section" aria-label="其他全局设置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          其他
          <SettingsLoadingInline :show="otherLoading" :text="otherLoadingText" />
        </h2>
        <p>除渠道外，其余全局配置暂时统一放在这里。</p>
      </div>
    </header>

    <label class="global-settings-field">
      <span>网络代理地址（留空则直连；例如 http://127.0.0.1:7890）</span>
      <input v-model="settings.common.proxy" type="text" placeholder="http://127.0.0.1:7890" />
    </label>

    <label class="global-settings-field">
      <span>数据目录路径（留空使用 VS Code 默认目录；保存后只迁移并删除旧目录中已注册的插件数据目录）</span>
      <input v-model="settings.common.dataFilePath" type="text" placeholder="例如：D:/limcode/data" />
    </label>

    <div class="global-settings-actions">
      <button type="button" @click="settings.saveCommon()">保存其他设置</button>
      <button type="button" class="secondary" @click="settings.requestAll()">重新读取</button>
      <span class="global-settings-status">{{ settings.status }}</span>
    </div>

    <div class="global-settings-path-list" aria-label="全局设置路径信息">
      <p class="global-settings-path">
        当前数据目录：<code>{{ settings.common.activeDataRootPath || '等待后端返回当前数据目录...' }}</code>
      </p>
      <p class="global-settings-path">
        默认数据目录：<code>{{ settings.common.defaultDataRootPath || '等待后端返回默认数据目录...' }}</code>
      </p>
      <p class="global-settings-path">
        路径配置保存位置：<code>{{ settings.filePaths.common || '等待后端返回 VS Code globalState 位置...' }}</code>
      </p>
      <p class="global-settings-path">
        当前渠道选择：<code>{{ settings.filePaths.llm || '等待后端返回 settings/llm.json 路径...' }}</code>
      </p>
      <p class="global-settings-path">
        渠道配置页：<code>{{ settings.filePaths.llmProviderConfigs || '等待后端返回 settings/llm-provider-configs/index.json 路径...' }}</code>
      </p>
    </div>
  </section>
</template>
