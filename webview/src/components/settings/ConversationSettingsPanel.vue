<script setup lang="ts">
import { computed } from 'vue';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import ToolPolicyEditor from '@webview/components/settings/tools/ToolPolicyEditor.vue';
import WorkEnvironmentPolicyEditor from '@webview/components/settings/workEnvironment/WorkEnvironmentPolicyEditor.vue';
import CheckpointPolicyEditor from '@webview/components/settings/checkpoints/CheckpointPolicyEditor.vue';
import CheckpointListPanel from '@webview/components/settings/checkpoints/CheckpointListPanel.vue';
import SystemPromptScopeEditor from '@webview/components/settings/config/SystemPromptScopeEditor.vue';
import RuntimeContextScopeEditor from '@webview/components/settings/config/RuntimeContextScopeEditor.vue';

const settings = useConversationSettingsStore();

const hasConversation = computed(() => !!settings.common.conversationId);

function reload(): void {
  settings.request(settings.common.conversationId);
}
</script>

<template>
  <section class="conversation-settings">
    <h2>对话设置</h2>
    <label class="field">
      <span>对话名称</span>
      <input v-model="settings.common.name" type="text" placeholder="输入对话名称" />
    </label>
    <div class="settings-actions">
      <button type="button" :disabled="!hasConversation" @click="settings.save()">保存对话设置</button>
      <button type="button" class="secondary" :disabled="!hasConversation" @click="reload">重新读取</button>
      <span class="settings-status">{{ settings.status }}</span>
    </div>
    <p class="settings-note">
      对话级 common 设置会保存到当前 conversation 目录下的 <code>settings/common.json</code>。
    </p>

    <SystemPromptScopeEditor
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话系统提示词"
      description="仅影响当前对话，会在 global / agent / mode 之后拼接。"
    />

    <RuntimeContextScopeEditor
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话运行时上下文模板"
      description="用于生成当前对话的运行时快照；可手动刷新快照，刷新不会写入聊天记录。"
    />

    <WorkEnvironmentPolicyEditor
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话工作环境策略"
      description="默认继承全局工作环境策略；修改任一工作环境后会为当前对话创建独立覆盖。"
    />

    <ToolPolicyEditor
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话工具策略"
      description="默认继承全局工具策略；修改任一工具后会为当前对话创建独立覆盖。"
    />

    <CheckpointPolicyEditor
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话存档点策略"
      description="默认继承全局存档点策略；修改后只影响当前对话。"
    />

    <CheckpointListPanel
      v-if="hasConversation"
      :conversation-id="settings.common.conversationId"
    />
  </section>
</template>

<style scoped>
.conversation-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

h2 {
  margin: 0;
  font-size: var(--font-size-md);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.field input {
  width: 100%;
  border-radius: var(--radius-md);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  padding: var(--space-2);
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.settings-status,
.settings-note {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  margin: 0;
}
</style>
