<script setup lang="ts">
import { computed, onMounted } from 'vue';
import CheckpointPolicyEditor from '@webview/components/settings/checkpoints/CheckpointPolicyEditor.vue';
import ShadowRepositoryManager from '@webview/components/settings/checkpoints/ShadowRepositoryManager.vue';
import { useCheckpointPolicyStore } from '@webview/stores/useCheckpointPolicyStore';

const checkpointStore = useCheckpointPolicyStore();
const gitStatus = computed(() => checkpointStore.gitStatus);

onMounted(() => {
  checkpointStore.requestGitStatus();
});
</script>

<template>
  <section class="global-settings-tab-section" aria-label="存档点设置">
    <header class="global-settings-section-header">
      <div>
        <h2>存档点</h2>
        <p>配置插件内部 shadow git 存档点。存档点绑定对话归属文件夹，不直接绑定当前工作环境。</p>
      </div>
    </header>

    <div class="checkpoint-git-status" :class="gitStatus?.available ? 'is-available' : gitStatus ? 'is-unavailable' : 'is-pending'">
      <div>
        <strong>系统 Git 检测</strong>
        <p>存档点依赖系统 <code>git</code> 命令；创建前会先检测，不依赖 VS Code Git 扩展。</p>
      </div>
      <span v-if="!gitStatus">检测中…</span>
      <span v-else-if="gitStatus.available">可用 · {{ gitStatus.version || 'git' }}</span>
      <span v-else>不可用 · {{ gitStatus.message }}</span>
    </div>

    <CheckpointPolicyEditor
      scope-kind="global"
      title="全局默认存档点策略"
      description="未配置对话、Agent 或模式覆盖时使用。shadow 仓库保存在插件数据目录中，不修改真实项目。"
    />

    <ShadowRepositoryManager />
  </section>
</template>

<style scoped>
.checkpoint-git-status {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-foreground) 5%);
}

.checkpoint-git-status strong {
  display: block;
  margin-bottom: var(--space-1);
}

.checkpoint-git-status p {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.checkpoint-git-status span {
  flex: none;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.checkpoint-git-status.is-unavailable span {
  color: var(--vscode-errorForeground);
}
</style>
