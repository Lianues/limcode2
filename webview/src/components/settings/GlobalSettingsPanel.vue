<script setup lang="ts">
import type { LlmProviderKind } from '@shared/protocol';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';

const settings = useGlobalSettingsStore();

const providerOptions: Array<{ value: LlmProviderKind; label: string }> = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' }
];
</script>

<template>
  <section class="settings-panel">
    <h2>全局配置</h2>
    <label class="field">
      <span>数据目录路径（留空使用 VS Code 默认目录；保存后只迁移并删除旧目录中已注册的插件数据目录）</span>
      <input v-model="settings.common.dataFilePath" type="text" placeholder="例如：D:/limcode/data" />
    </label>

    <h2>LLM 设置</h2>
    <div class="settings-grid">
      <label class="field">
        <span>Provider</span>
        <select v-model="settings.llm.provider">
          <option v-for="option in providerOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <label class="field">
        <span>Base URL</span>
        <input v-model="settings.llm.baseUrl" type="text" placeholder="https://api.deepseek.com/v1" />
      </label>
      <label class="field">
        <span>Model</span>
        <input v-model="settings.llm.model" type="text" placeholder="deepseek-v4-flash" />
      </label>
      <label class="field">
        <span>Temperature</span>
        <input v-model.number="settings.llm.temperature" type="number" min="0" max="2" step="0.1" />
      </label>
      <label class="field">
        <span>HTTP/HTTPS 代理（可选）</span>
        <input v-model="settings.llm.proxy" type="text" placeholder="例如：http://localhost:8000" />
      </label>
    </div>

    <label class="field api-key-field">
      <span>API Key（明文显示 / 明文保存）</span>
      <input v-model="settings.llm.apiKey" type="text" placeholder="sk-..." autocomplete="off" spellcheck="false" />
    </label>

    <div class="settings-actions">
      <button type="button" @click="settings.saveCommon()">保存全局设置</button>
      <button type="button" @click="settings.saveLlm()">保存 LLM 设置</button>
      <button type="button" class="secondary" @click="settings.requestAll()">重新读取</button>
      <span class="settings-status">{{ settings.status }}</span>
    </div>

    <p class="settings-path">
      当前数据目录：<code>{{ settings.common.activeDataRootPath || '等待后端返回当前数据目录...' }}</code>
    </p>
    <p class="settings-path">
      默认数据目录：<code>{{ settings.common.defaultDataRootPath || '等待后端返回默认数据目录...' }}</code>
    </p>
    <p class="settings-path">
      路径配置保存位置：<code>{{ settings.filePaths.common || '等待后端返回 VS Code globalState 位置...' }}</code>
    </p>
    <p class="settings-path">
      LLM 文件：<code>{{ settings.filePaths.llm || '等待后端返回 settings/llm.json 路径...' }}</code>
    </p>
  </section>
</template>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

h2 {
  margin: 0;
  font-size: var(--font-size-md);
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.field input,
.field select {
  width: 100%;
  border-radius: var(--radius-md);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  padding: var(--space-2);
}

.api-key-field input {
  font-family: var(--vscode-editor-font-family, monospace);
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.settings-status,
.settings-path {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  margin: 0;
}

.settings-path code {
  word-break: break-all;
}

@media (max-width: 640px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
