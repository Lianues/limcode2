<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { IconMessage } from '@tabler/icons-vue';
import type { ProjectFolderCandidateRecord } from '@shared/protocol';
import { displayConversationTitle } from '@shared/conversationTitle';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useChat } from '@webview/composables/useChat';
import { bridge, BridgeMessageType } from '@webview/transport';

const props = defineProps<{
  settingsOpen: boolean;
}>();

const emit = defineEmits<{
  (event: 'toggle-settings'): void;
}>();

const clientState = useClientStateStore();
const { abortCurrentConversation } = useChat();

const headerRoot = ref<HTMLElement | null>(null);
const projectDropdownOpen = ref(false);
const projectFolders = ref<ProjectFolderCandidateRecord[]>([]);
const projectFoldersLoaded = ref(false);

const title = computed(() => {
  const conversationId = clientState.currentConversation?.id ?? clientState.currentConversationId;
  if (!conversationId) return '正在初始化默认对话...';
  return displayConversationTitle({ id: conversationId, title: clientState.currentConversation?.title, messages: clientState.currentMessages });
});
const runSummary = computed(() => clientState.currentRunSummary);
const runStatusClass = computed(() => `run-status-${runSummary.value.status ?? 'idle'}`);
const currentProject = computed(() => clientState.currentProjectContext);
const projectPath = computed(() => currentProject.value ? displayProjectUri(currentProject.value.uri) : '未绑定项目');
const compactProjectPath = computed(() => middleEllipsis(projectPath.value, 58));
const activeProjectUri = computed(() => currentProject.value?.uri ?? '');

let disposeProjectFolders: (() => void) | undefined;

onMounted(() => {
  disposeProjectFolders = bridge.on(BridgeMessageType.ProjectFoldersSnapshot, (message) => {
    projectFolders.value = message.payload?.folders ?? [];
    projectFoldersLoaded.value = true;
  });
  document.addEventListener('click', onDocumentClick);
});

onBeforeUnmount(() => {
  disposeProjectFolders?.();
  document.removeEventListener('click', onDocumentClick);
});

function onAbort(): void {
  abortCurrentConversation();
}

function toggleProjectDropdown(): void {
  projectDropdownOpen.value = !projectDropdownOpen.value;
  if (projectDropdownOpen.value) requestProjectFolders();
}

function requestProjectFolders(): void {
  bridge.request(BridgeMessageType.ProjectFoldersGet, undefined, { channel: 'state' });
}

function setConversationProject(folder: ProjectFolderCandidateRecord): void {
  const conversationId = clientState.currentConversationId;
  if (!conversationId) return;
  bridge.request(BridgeMessageType.ConversationProjectSet, {
    conversationId,
    folderUri: folder.uri,
    name: folder.name
  });
  projectDropdownOpen.value = false;
}

function onDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!headerRoot.value?.contains(target)) projectDropdownOpen.value = false;
}

function displayProjectUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'file:') {
      const decoded = decodeURIComponent(parsed.pathname);
      return decoded.replace(/^\/([A-Za-z]:)/, '$1');
    }
  } catch {
    // ignore and use raw uri
  }
  return uri;
}

function middleEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(4, Math.floor((maxLength - 3) / 2));
  const head = value.slice(0, keep);
  const tail = value.slice(value.length - keep);
  return `${head}...${tail}`;
}
</script>

<template>
  <header ref="headerRoot" class="tab-header">
    <div class="tab-header-main">
      <div class="tab-title-row">
        <span class="tab-title">{{ title }}</span>
        <span class="project-path-wrap">
          <button
            type="button"
            class="project-path-button"
            :class="{ 'is-unbound': !currentProject }"
            :title="projectPath"
            :aria-expanded="projectDropdownOpen"
            aria-haspopup="listbox"
            @click.stop="toggleProjectDropdown"
          >
            {{ compactProjectPath }}
          </button>
          <Transition name="lc-dropdown">
            <section v-if="projectDropdownOpen" class="project-dropdown lc-dropdown-panel" @click.stop>
              <div class="project-dropdown-title">切换对话归属</div>
              <div v-if="!projectFoldersLoaded" class="project-dropdown-empty">正在读取工作区...</div>
              <div v-else-if="!projectFolders.length" class="project-dropdown-empty">当前窗口没有可绑定的文件夹。</div>
              <button
                v-for="folder in projectFolders"
                :key="folder.uri"
                type="button"
                class="project-option"
                :class="{ 'is-active': folder.uri === activeProjectUri }"
                :title="displayProjectUri(folder.uri)"
                @click="setConversationProject(folder)"
              >
                <span class="project-option-name">{{ folder.name }}</span>
                <span class="project-option-path">{{ middleEllipsis(displayProjectUri(folder.uri), 64) }}</span>
              </button>
            </section>
          </Transition>
        </span>
        <span
          class="run-status"
          :class="[runStatusClass, { 'is-active': runSummary.isRunning }]"
          :title="runSummary.isRunning ? `后台任务：${runSummary.label}` : '当前无后台任务'"
        >
          <span class="run-status-dot" aria-hidden="true"></span>
          <span>{{ runSummary.isRunning ? runSummary.label : '空闲' }}</span>
        </span>
      </div>
    </div>
    <div class="tab-actions">
      <button
        v-if="runSummary.isRunning"
        type="button"
        class="tab-abort-button"
        title="手动终止当前对话的后台任务"
        @click="onAbort"
      >
        终止
      </button>
      <button
        type="button"
        class="tab-settings-toggle secondary"
        :aria-label="props.settingsOpen ? '收起对话设置' : '打开对话设置'"
        :aria-pressed="props.settingsOpen"
        :title="props.settingsOpen ? '收起对话设置' : '对话设置'"
        @click="emit('toggle-settings')"
      >
        <IconMessage class="tab-settings-icon" stroke="2" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.tab-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 0;
  border-bottom: 1px solid var(--vscode-panel-border);
  --tab-header-row-height: 24px;
}

.tab-header-main {
  flex: 1 1 auto;
  min-width: 0;
}

.tab-title-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: nowrap;
  min-height: var(--tab-header-row-height);
}

.tab-title {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 34%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.project-path-wrap {
  position: relative;
  flex: 1 1 auto;
  min-width: 48px;
  display: inline-flex;
}

.project-path-button {
  width: 100%;
  min-width: 0;
  min-height: 22px;
  padding: 0 var(--space-1);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-xs);
  line-height: 1.4;
  text-align: left;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.project-path-button:hover,
.project-path-button[aria-expanded='true'] {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.project-path-button.is-unbound {
  font-style: italic;
}

.project-dropdown {
  position: absolute;
  left: 0;
  top: calc(100% + 4px);
  z-index: 20;
  width: 100%;
  max-height: 260px;
  overflow: auto;
  padding: var(--space-2);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-editor-background);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22);
}

.project-dropdown-title {
  margin: 0 0 var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.project-dropdown-empty {
  padding: var(--space-2) 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.project-option {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  min-height: 0;
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.project-option:hover,
.project-option.is-active {
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.project-option-name {
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.project-option-path {
  min-width: 0;
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.run-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 20px;
  padding: 1px 7px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-sm);
  line-height: 1.4;
}

.run-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-descriptionForeground);
  opacity: 0.55;
}

.run-status.is-active {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.run-status.is-active .run-status-dot {
  background: var(--vscode-testing-iconQueued);
  opacity: 1;
  animation: lc-status-pulse-glow var(--lc-status-pulse-duration) infinite ease-in-out;
}

.run-status-paused .run-status-dot {
  background: var(--vscode-testing-iconSkipped);
  animation: none;
}

.run-status-waiting_tool .run-status-dot,
.run-status-waiting_child_run .run-status-dot {
  background: var(--vscode-testing-iconQueued);
}

.tab-actions {
  flex: 0 0 auto;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--tab-header-row-height);
}

.tab-abort-button {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--tab-header-row-height);
  min-height: var(--tab-header-row-height);
  padding: 0 var(--space-2);
  font-size: var(--font-size-xs);
  line-height: 1;
}

.tab-settings-toggle {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--tab-header-row-height);
  height: var(--tab-header-row-height);
  min-width: var(--tab-header-row-height);
  min-height: var(--tab-header-row-height);
  padding: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border-color: transparent;
}

.tab-settings-toggle:hover:not(:disabled),
.tab-settings-toggle[aria-pressed='true'] {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.tab-settings-icon {
  width: 16px;
  height: 16px;
  color: currentColor;
  pointer-events: none;
}

.tab-abort-button {
  border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  color: var(--vscode-errorForeground);
  background: transparent;
  cursor: pointer;
}

.tab-abort-button:hover {
  background: var(--vscode-inputValidation-errorBackground, var(--vscode-list-hoverBackground));
}
</style>
