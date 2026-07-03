<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconFolder, IconListDetails, IconPaperclip, IconPencilExclamation, IconPlayerStop, IconRobot, IconSend2, IconTrash, IconWorld } from '@tabler/icons-vue';
import { workEnvironmentDisplayPath, workEnvironmentSortKey as buildWorkEnvironmentSortKey } from '@shared/workEnvironmentCatalog';
import type { AgentRecord, InlineDataPart, MessageContent, WorkEnvironmentRecord } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import { useConversationUiStore } from '@webview/stores/useConversationUiStore';
import { GLOBAL_MODE_OPTION_ID, useModeStore } from '@webview/stores/useModeStore';
import { useWorkEnvironmentStore } from '@webview/stores/useWorkEnvironmentStore';
import { useAgentStore } from '@webview/stores/useAgentStore';
import { useCompression } from '@webview/composables/useCompression';
import { useChat } from '@webview/composables/useChat';
import RichContentEditor from '@webview/components/content/RichContentEditor.vue';
import QueuePanel, { type QueueItem } from '@webview/components/input/QueuePanel.vue';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import ContextTokenUsageBar from '@webview/components/conversation/ContextTokenUsageBar.vue';
import AgentRunPanel from '@webview/components/input/AgentRunPanel.vue';
import BackgroundCommandPanel from '@webview/components/input/BackgroundCommandPanel.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    placeholder?: string;
    expandBoundary?: HTMLElement | null;
  }>(),
  { disabled: false, placeholder: '', expandBoundary: null }
);

const emit = defineEmits<{
  (event: 'submit', text: string, content?: MessageContent): void;
}>();

const clientState = useClientStateStore();
const conversationTimeline = useConversationTimelineStore();
const globalSettings = useGlobalSettingsStore();
const conversationSettings = useConversationSettingsStore();
const modeStore = useModeStore();
const agentStore = useAgentStore();
const workEnvironmentStore = useWorkEnvironmentStore();
const compression = useCompression();
const ui = useConversationUiStore();
const { abortCurrentConversation, removeQueueRun, promoteQueueRun, reorderQueue, pauseQueueRun, resumeQueueRun, resumeAllQueueRuns } = useChat();
const highlighted = ref(false);
const editorExpanded = ref(false);
const editor = ref<{ focus: () => void } | null>(null);
const editorShell = ref<HTMLElement | null>(null);
const expandedEditorHeight = ref(0);
const collapsedEditorHeight = ref(0);
const agentDropdownCloseSignal = ref(0);
const modeDropdownCloseSignal = ref(0);
const channelDropdownCloseSignal = ref(0);
const workEnvironmentDropdownCloseSignal = ref(0);
const fileInput = ref<HTMLInputElement | null>(null);
const attachmentScroller = ref<HTMLElement | null>(null);

const draft = computed({
  get: () => ui.composerDraft,
  set: (next: string) => ui.setComposerDraft(next)
});
const expandTitle = computed(() => (editorExpanded.value ? '恢复输入框高度' : '扩大输入框'));
const sendTitle = computed(() => {
  if (ui.isEditing) return '提交编辑';
  return runSummary.value.isRunning ? '加入消息队列，下次 LLM 调用时合并发送' : '发送';
});
const compacting = computed(() => conversationTimeline.currentCompressionBlocks.some((block) => block.status === 'pending' || block.status === 'running'));
const compactTitle = computed(() => compacting.value ? '取消上下文压缩' : '压缩当前上下文');
const runSummary = computed(() => clientState.currentRunSummary);
const channelOptions = computed<SettingsDropdownOption[]>(() =>
  globalSettings.llmProviderConfigs.configs.map((config) => ({
    value: config.id,
    label: config.name,
    description: config.model ? `${providerLabel(config.provider)} · ${config.model}` : providerLabel(config.provider)
  }))
);
const workEnvironmentOptions = computed<SettingsDropdownOption[]>(() =>
  workEnvironmentStore.allowedEnvironmentsForConversation(clientState.currentConversationId)
    .sort((left, right) => workEnvironmentSortKey(left).localeCompare(workEnvironmentSortKey(right), 'zh-CN') || left.id.localeCompare(right.id))
    .map((environment) => ({
      value: environment.id,
      label: environment.name,
      description: middleEllipsis(workEnvironmentDisplayPath(environment), 58),
      icon: IconFolder
    }))
);
const modeOptions = computed<SettingsDropdownOption[]>(() => [
  {
    value: GLOBAL_MODE_OPTION_ID,
    label: 'Global',
    description: '使用全局策略',
    icon: IconWorld
  },
  ...modeStore.modes.map((mode) => ({
    value: mode.id,
    label: mode.name,
    description: mode.description || (mode.source === 'builtin' ? '内置模式' : '用户模式'),
    icon: IconListDetails
  }))
]);
const activeConversationAgent = computed(() => agentStore.activeAgentForConversation(clientState.currentConversationId));
const agentOptions = computed<SettingsDropdownOption[]>(() => {
  const options = agentStore.configurableAgents.map((agent) => agentOption(agent));
  const active = activeConversationAgent.value;
  if (active?.runtimeRole === 'mirror' && !options.some((option) => option.value === active.id)) {
    options.unshift(agentOption(active, true));
  }
  return options;
});
const activeAgentId = computed({
  get: () => activeConversationAgent.value?.id ?? agentOptions.value[0]?.value ?? '',
  set: (agentId: string) => selectAgent(agentId)
});
const activeModeId = computed({
  get: () => modeStore.activeModeIdForConversation(clientState.currentConversationId),
  set: (modeId: string) => selectMode(modeId)
});
const activeChannelId = computed({
  get: () => conversationSettings.llm.activeProviderConfigId || globalSettings.llm.activeProviderConfigId || globalSettings.activeLlmProviderConfig?.id || '',
  set: (configId: string) => selectChannel(configId)
});
const activeWorkEnvironmentId = computed({
  get: () => workEnvironmentStore.activeEnvironmentForConversation(clientState.currentConversationId)?.id ?? workEnvironmentOptions.value[0]?.value ?? '',
  set: (workEnvironmentId: string) => selectWorkEnvironment(workEnvironmentId)
});
const editorShellStyle = computed(() => {
  if (!editorExpanded.value || !expandedEditorHeight.value) return undefined;
  return {
    '--composer-expanded-editor-height': `${expandedEditorHeight.value}px`
  };
});
const selectedAttachments = ref<InlineDataPart[]>([]);
const attachmentRefreshKey = computed(() => selectedAttachments.value.map((part, index) => index + ':' + (part.inlineData.name ?? '') + ':' + (part.inlineData.sizeBytes ?? 0)).join('|'));
const hasDraftContent = computed(() => draft.value.trim().length > 0 || selectedAttachments.value.length > 0);
const attachmentLimitBytes = computed(() => Math.max(1, globalSettings.attachments.maxStoredInlineFileMb || 20) * 1024 * 1024);

let highlightTimer: number | undefined;

watch(
  () => ui.composerHighlightKey,
  () => {
    if (!ui.isEditing) return;
    pulseHighlight();
    void nextTick(() => editor.value?.focus());
  }
);

onMounted(() => {
  globalSettings.ensureAttachments();
  window.addEventListener('keydown', onWindowKeydown);
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
  window.removeEventListener('resize', onWindowResize);
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
});

function onWindowKeydown(event: KeyboardEvent): void {
  if (!ui.isEditing || event.key !== 'Escape') return;
  event.preventDefault();
  ui.cancelEditMode();
}

function onWindowResize(): void {
  if (!editorExpanded.value) return;
  updateExpandedEditorHeight();
}

function submit(): void {
  const text = draft.value.trim();
  if ((!text && selectedAttachments.value.length === 0) || props.disabled) return;
  const content = buildMessageContent(text, selectedAttachments.value);
  emit('submit', text, content);
  selectedAttachments.value = [];
  if (!ui.isEditing) ui.clearChatDraft();
}

function openFilePicker(): void { fileInput.value?.click(); }

async function onPasteFiles(files: File[]): Promise<void> {
  await addFilesAsAttachments(files);
}

async function onAttachmentFilesChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null;
  const files = [...(input?.files ?? [])];
  if (input) input.value = '';
  await addFilesAsAttachments(files);
}

async function addFilesAsAttachments(files: File[]): Promise<void> {
  for (const file of files) {
    if (file.size > attachmentLimitBytes.value) {
      globalSettings.status = `附件 ${file.name} 超过 ${globalSettings.attachments.maxStoredInlineFileMb || 20}MB，未添加。`;
      continue;
    }
    const mimeType = file.type || 'application/octet-stream';
    const data = await readFileAsBase64(file);
    selectedAttachments.value.push({ inlineData: { mimeType, data, name: file.name, storage: 'embedded', status: 'available', sizeBytes: file.size } });
  }
}

function removeAttachment(index: number): void {
  selectedAttachments.value.splice(index, 1);
}

function buildMessageContent(text: string, attachments: InlineDataPart[]): MessageContent | undefined {
  if (attachments.length === 0) return undefined;
  return {
    role: 'user',
    parts: [
      ...(text ? [{ text }] : []),
      ...attachments.map((part) => ({ inlineData: { ...part.inlineData } }))
    ]
  };
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      resolve(value.replace(/^data:[^,]+,/, ''));
    };
    reader.readAsDataURL(file);
  });
}

function attachmentDisplayName(part: InlineDataPart): string {
  return part.inlineData.name || part.inlineData.mimeType;
}

function attachmentSizeLabel(part: InlineDataPart): string {
  const bytes = part.inlineData.sizeBytes;
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function onAttachmentWheel(event: WheelEvent): void {
  const element = attachmentScroller.value;
  if (!element) return;
  const maxScrollLeft = element.scrollWidth - element.clientWidth;
  if (maxScrollLeft <= 1) return;

  const rawDelta = event.deltaX || event.deltaY;
  if (!rawDelta) return;
  event.preventDefault();

  const unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE
    ? element.clientWidth
    : event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 24
      : 1;
  element.scrollLeft = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft + rawDelta * unit));
}

function abortConversation(): void {
  abortCurrentConversation();
}

function onQueueEdit(item: QueueItem): void {
  ui.startEditQueueItem(item.runId, item.text);
}

function onQueueDelete(runId: string): void {
  removeQueueRun(runId);
}

function onQueueForceSend(runId: string): void {
  promoteQueueRun(runId);
}

function onQueueReorder(runIds: string[]): void {
  reorderQueue(runIds);
}

function onQueuePause(runId: string): void {
  pauseQueueRun(runId);
}

function onQueueResume(runId: string): void {
  resumeQueueRun(runId);
}

function onQueueResumeAll(): void {
  resumeAllQueueRuns();
}

function compactConversation(): void {
  if (props.disabled) return;
  compression.createCompression();
}


function toggleEditorExpanded(): void {
  if (!editorExpanded.value) {
    collapsedEditorHeight.value = editorShell.value?.getBoundingClientRect().height ?? 0;
    updateExpandedEditorHeight();
  }

  editorExpanded.value = !editorExpanded.value;
  void nextTick(() => {
    if (editorExpanded.value) updateExpandedEditorHeight();
    editor.value?.focus();
  });
}

function updateExpandedEditorHeight(): void {
  const shell = editorShell.value;
  if (!shell) return;

  const shellRect = shell.getBoundingClientRect();
  const boundaryRect = props.expandBoundary?.getBoundingClientRect();
  const boundaryTop = boundaryRect?.top ?? 0;
  const availableHeight = shellRect.bottom - boundaryTop;
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return;

  const minHeight = collapsedEditorHeight.value || shellRect.height;
  expandedEditorHeight.value = Math.floor(Math.min(availableHeight, Math.max(minHeight, availableHeight * 0.9)));
}

function pulseHighlight(): void {
  highlighted.value = true;
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => {
    highlighted.value = false;
    highlightTimer = undefined;
  }, 650);
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'openai-compatible':
      return 'OpenAI Compatible';
    case 'openai-responses':
      return 'OpenAI Responses';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    case 'deepseek':
      return 'DeepSeek';
    default:
      return provider;
  }
}

function selectChannel(configId: string): void {
  if (!configId) return;
  const conversationId = clientState.currentConversationId;
  if (conversationId) {
    conversationSettings.selectLlmProviderConfigForConversation(conversationId, configId);
    return;
  }
  globalSettings.selectLlmProviderConfig(configId);
}

function selectAgent(agentId: string): void {
  const conversationId = clientState.currentConversationId;
  if (!conversationId || !agentId) return;
  agentStore.selectAgent(conversationId, agentId);
}

function selectMode(modeId: string): void {
  const conversationId = clientState.currentConversationId;
  if (!conversationId) return;
  if (modeId === GLOBAL_MODE_OPTION_ID) {
    modeStore.selectGlobal(conversationId);
    return;
  }
  modeStore.selectMode(conversationId, modeId);
}

function selectWorkEnvironment(workEnvironmentId: string): void {
  if (!workEnvironmentId) return;
  const conversationId = clientState.currentConversationId;
  if (!conversationId) return;
  workEnvironmentStore.selectConversationEnvironment(conversationId, workEnvironmentId);
}

function onAgentDropdownOpen(): void { modeDropdownCloseSignal.value += 1; channelDropdownCloseSignal.value += 1; workEnvironmentDropdownCloseSignal.value += 1; }
function onModeDropdownOpen(): void {
  agentDropdownCloseSignal.value += 1;
  channelDropdownCloseSignal.value += 1;
  workEnvironmentDropdownCloseSignal.value += 1;
}

function onChannelDropdownOpen(): void {
  agentDropdownCloseSignal.value += 1;
  modeDropdownCloseSignal.value += 1;
  workEnvironmentDropdownCloseSignal.value += 1;
}

function onWorkEnvironmentDropdownOpen(): void {
  agentDropdownCloseSignal.value += 1;
  modeDropdownCloseSignal.value += 1;
  channelDropdownCloseSignal.value += 1;
}

function workEnvironmentSortKey(environment: WorkEnvironmentRecord): string {
  return buildWorkEnvironmentSortKey(environment);
}

function agentOption(agent: AgentRecord, disabled = false): SettingsDropdownOption {
  return {
    value: agent.id,
    label: agent.name,
    description: agent.description || agentSourceDescription(agent),
    icon: IconRobot,
    disabled
  };
}

function agentSourceDescription(agent: AgentRecord): string {
  if (agent.runtimeRole === 'mirror') return `临时镜像 · ${agent.typeAgentId ?? agent.kind}`;
  if (agent.source === 'builtin') return `内置 Agent · ${agent.kind}`;
  return `用户 Agent · ${agent.kind}`;
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
  <div class="composer" :class="{ 'is-editing': ui.isEditing, 'is-highlighted': highlighted, 'is-editor-expanded': editorExpanded }">
    <div class="composer-zone composer-zone-top" aria-label="输入框上方功能区">
      <div class="composer-top-main">
        <QueuePanel
          @edit="onQueueEdit"
          @delete="onQueueDelete"
          @force-send="onQueueForceSend"
          @reorder="onQueueReorder"
          @pause="onQueuePause"
          @resume="onQueueResume"
          @resume-all="onQueueResumeAll"
        />
        <div v-if="ui.isEditing" class="composer-edit-indicator">
          <span class="composer-edit-indicator-icon" aria-hidden="true">
            <IconPencilExclamation stroke="2" />
          </span>
          <span class="composer-edit-text">{{ ui.editingQueueRunId ? '正在编辑排队消息，发送后替换原排队消息。' : '正在编辑消息，发送前需要确认。' }}</span>
          <button type="button" class="composer-edit-cancel" @click="ui.cancelEditMode">取消编辑</button>
        </div>
        <div v-if="selectedAttachments.length" class="composer-attachments-shell">
          <div ref="attachmentScroller" class="composer-attachments" aria-label="已选择附件" @wheel="onAttachmentWheel">
            <span v-for="(attachment, index) in selectedAttachments" :key="`${attachment.inlineData.name}-${index}`" class="composer-attachment-chip">
              <span class="composer-attachment-name">{{ attachmentDisplayName(attachment) }}</span>
              <span v-if="attachmentSizeLabel(attachment)" class="composer-attachment-size">{{ attachmentSizeLabel(attachment) }}</span>
              <button type="button" class="composer-attachment-remove" title="移除附件" @click="removeAttachment(index)">
                <IconTrash stroke="2" aria-hidden="true" />
              </button>
            </span>
          </div>
          <AdvancedScrollbar
            class="composer-attachments-scrollbar"
            :scroller="attachmentScroller"
            :refresh-key="attachmentRefreshKey"
            variant="minimal"
            orientation="horizontal"
          />
        </div>
      </div>
      <div class="composer-top-actions">
        <AgentRunPanel />
        <BackgroundCommandPanel />
      </div>
    </div>

    <div class="composer-input-row">
      <div class="composer-zone composer-zone-left" aria-label="输入框左侧功能区"></div>
      <div ref="editorShell" class="composer-editor-shell" :style="editorShellStyle">
        <RichContentEditor
          ref="editor"
          v-model="draft"
          class="composer-editor"
          :placeholder="ui.isEditing ? (ui.editingQueueRunId ? '编辑排队消息内容...' : '编辑消息内容...') : placeholder"
          :disabled="disabled"
          :rows="5"
          @submit="submit"
          @paste-files="onPasteFiles"
        />
      </div>
      <div class="composer-zone composer-zone-right" aria-label="输入框右侧功能区">
        <input
          ref="fileInput"
          type="file"
          class="composer-file-input"
          multiple
          accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,audio/*,video/*"
          @change="onAttachmentFilesChange"
        />
        <button
          type="button"
          class="composer-side-action"
          :aria-label="expandTitle"
          :aria-pressed="editorExpanded"
          :title="expandTitle"
          @click="toggleEditorExpanded"
        >
          <svg
            v-if="!editorExpanded"
            class="composer-side-action-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path stroke="none" d="M0 0h24v24H0z" fill="none" />
            <path d="M9 18l3 3l3 -3" />
            <path d="M12 15v6" />
            <path d="M15 6l-3 -3l-3 3" />
            <path d="M12 3v6" />
          </svg>
          <svg
            v-else
            class="composer-side-action-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path stroke="none" d="M0 0h24v24H0z" fill="none" />
            <path d="M9 6l3 3l3 -3" />
            <path d="M12 3v6" />
            <path d="M15 18l-3 -3l-3 3" />
            <path d="M12 15v6" />
          </svg>
        </button>
        <button
          type="button"
          class="composer-side-action"
          aria-label="添加附件"
          title="添加图片、PDF、文本、音频或视频附件"
          :disabled="disabled"
          @click="openFilePicker"
        >
          <IconPaperclip class="composer-side-action-icon" stroke="2" aria-hidden="true" />
        </button>
        <button
          v-if="runSummary.isRunning"
          type="button"
          class="composer-side-action composer-side-abort"
          aria-label="终止当前对话的后台任务"
          title="终止当前对话的后台任务"
          @click="abortConversation"
        >
          <IconPlayerStop class="composer-side-action-icon" stroke="2" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div class="composer-zone composer-zone-bottom" aria-label="输入框下方功能区">
      <div v-if="agentOptions.length || modeOptions.length || channelOptions.length || workEnvironmentOptions.length" class="composer-meta">
        <template v-if="agentOptions.length">
          <SettingsDropdown
            v-model="activeAgentId"
            class="composer-meta-dropdown composer-agent-dropdown"
            :options="agentOptions"
            title="切换当前 Agent"
            searchable
            search-placeholder="筛选 Agent..."
            :close-signal="agentDropdownCloseSignal"
            :max-height="220"
            @open="onAgentDropdownOpen"
          />
        </template>
        <template v-if="modeOptions.length">
          <SettingsDropdown
            v-model="activeModeId"
            class="composer-meta-dropdown composer-mode-dropdown"
            :options="modeOptions"
            title="切换对话模式"
            searchable
            search-placeholder="筛选模式..."
            :close-signal="modeDropdownCloseSignal"
            :max-height="220"
            @open="onModeDropdownOpen"
          />
        </template>
        <template v-if="channelOptions.length">
          <SettingsDropdown
            v-model="activeChannelId"
            class="composer-meta-dropdown composer-channel-dropdown"
            :options="channelOptions"
            title="切换渠道配置页"
            empty-text="暂无渠道配置"
            searchable
            search-placeholder="筛选渠道..."
            :close-signal="channelDropdownCloseSignal"
            :max-height="220"
            @open="onChannelDropdownOpen"
          />
        </template>
        <template v-if="workEnvironmentOptions.length">
          <SettingsDropdown
            v-model="activeWorkEnvironmentId"
            class="composer-meta-dropdown composer-work-environment-dropdown"
            :options="workEnvironmentOptions"
            title="切换工作环境"
            empty-text="暂无工作环境"
            searchable
            search-placeholder="筛选工作环境..."
            :close-signal="workEnvironmentDropdownCloseSignal"
            :max-height="220"
            @open="onWorkEnvironmentDropdownOpen"
          />
        </template>
      </div>
      <ContextTokenUsageBar class="composer-token-usage" />
      <button
        type="button"
        class="composer-compact"
        :class="{ 'is-compacting': compacting }"
        :disabled="disabled || (!compacting && conversationTimeline.currentMessages.length < 2)"
        aria-label="压缩上下文"
        :title="compactTitle"
        @click="compactConversation"
      >
        <svg class="composer-compact-icon" :class="{ 'is-compacting': compacting }" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path class="composer-compact-icon-top" d="M5 5h14l-7 6z" />
          <path class="composer-compact-icon-bottom" d="M5 19h14l-7 -6z" />
        </svg>
      </button>
      <button
        type="button"
        class="composer-send"
        :disabled="disabled || !hasDraftContent"
        :aria-label="sendTitle"
        :title="sendTitle"
        @click="submit"
      >
        <IconSend2 class="composer-send-icon" stroke="2" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.composer-input-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-1);
  min-width: 0;
}

.composer-zone {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.composer-zone:empty {
  display: none;
}

.composer-zone-left,
.composer-zone-right {
  flex: 0 0 auto;
}

.composer-zone-right {
  align-self: stretch;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: var(--space-1);
}

.composer-zone-top {
  min-height: 28px;
  align-items: flex-start;
  justify-content: space-between;
}

.composer-top-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.composer-top-actions {
  flex: 0 0 auto;
  min-height: 28px;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  gap: var(--space-1);
  margin-left: auto;
}

.composer-zone-bottom {
  justify-content: flex-end;
  align-items: center;
}

.composer-edit-indicator {
  width: 100%;
  min-height: 20px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.composer-edit-indicator-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.composer-edit-indicator-icon :deep(svg) {
  width: 16px;
  height: 16px;
}

.composer-edit-text {
  flex: 1;
  min-width: 0;
}

.composer-edit-cancel {
  min-height: 24px;
  padding: 0 var(--space-2);
  border-color: transparent;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.composer-edit-cancel:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: transparent;
  border-color: transparent;
}

.composer-editor-shell {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.composer-file-input {
  display: none;
}

.composer-attachments-shell {
  position: relative;
  width: 100%;
  min-width: 0;
  height: 32px;
  padding-bottom: 6px;
}

.composer-attachments {
  width: 100%;
  min-width: 0;
  height: 26px;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-1);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.composer-attachments::-webkit-scrollbar {
  display: none;
}

.composer-attachments-scrollbar {
  z-index: 2;
}

.composer-attachment-chip {
  flex: 0 0 auto;
  max-width: min(260px, 72vw);
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px 4px 2px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  font-size: var(--font-size-xs);
}

.composer-attachment-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vscode-foreground);
}

.composer-attachment-size {
  flex: 0 0 auto;
}

.composer-attachment-remove {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.composer-attachment-remove:hover,
.composer-attachment-remove:focus-visible {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.composer-attachment-remove svg {
  width: 13px;
  height: 13px;
}

.composer.is-editor-expanded .composer-editor-shell {
  height: var(--composer-expanded-editor-height);
}

.composer-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  transition: border-color var(--lc-composer-highlight-duration) ease, box-shadow var(--lc-composer-highlight-duration) ease;
}

.composer.is-editor-expanded .composer-editor {
  height: 100%;
}

.composer.is-highlighted .composer-editor {
  border-color: var(--vscode-editorWarning-foreground, #cca700);
  box-shadow: inset 0 0 0 1px var(--vscode-editorWarning-foreground, #cca700);
}

.composer-side-action {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border-color: transparent;
}

.composer-side-action:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.composer-side-action:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  border-color: transparent;
  opacity: 0.55;
  cursor: not-allowed;
}

.composer-side-action-icon {
  width: 16px;
  height: 16px;
  color: currentColor;
  pointer-events: none;
}

.composer-side-abort {
  margin-top: auto;
}

.composer-meta {
  flex: 1 1 auto;
  min-width: 0;
  margin-right: auto;
  overflow: visible;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.4;
  white-space: nowrap;
}

.composer-meta code {
  font-size: inherit;
}

.composer-meta-dropdown {
  --lc-dropdown-transform-origin: bottom left;
  --lc-dropdown-offset-y: 4px;
}

.composer-mode-dropdown {
  width: min(180px, 28vw);
  min-width: 118px;
}

.composer-agent-dropdown {
  width: min(180px, 28vw);
  min-width: 118px;
}

.composer-channel-dropdown {
  width: min(180px, 28vw);
  min-width: 118px;
}

.composer-work-environment-dropdown {
  width: min(210px, 32vw);
  min-width: 130px;
}

.composer-meta-dropdown :deep(button.settings-dropdown-button) {
  min-height: 24px;
  border-color: transparent;
  padding: 2px 6px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-sm);
}

.composer-meta-dropdown :deep(button.settings-dropdown-button:hover:not(:disabled)),
.composer-meta-dropdown :deep(button.settings-dropdown-button[aria-expanded='true']),
.composer-meta-dropdown :deep(button.settings-dropdown-button:focus-visible),
.composer-meta-dropdown :deep(button.settings-dropdown-button:active) {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
}

.composer-meta-dropdown :deep(.settings-dropdown-panel) {
  top: auto;
  bottom: calc(100% + 4px);
  width: 100%;
}

.composer-meta-dropdown :deep(.settings-dropdown-caret) {
  color: currentColor;
}

.composer-token-usage {
  flex: 0 0 auto;
  margin-left: var(--space-1);
}

.composer-send,
.composer-compact {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 30px;
  padding: 0;
  color: var(--vscode-foreground);
  background: transparent;
  border-color: transparent;
}

.composer-send:hover:not(:disabled),
.composer-compact:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.composer-send:disabled,
.composer-compact:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  border-color: transparent;
  opacity: 0.55;
  cursor: not-allowed;
}

.composer-send-icon,
.composer-compact-icon {
  width: 16px;
  height: 16px;
  color: currentColor;
  pointer-events: none;
}

.composer-compact-icon path {
  fill: currentColor;
}

.composer-compact.is-compacting,
.composer-compact-icon.is-compacting {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.composer-compact-icon.is-compacting .composer-compact-icon-top {
  animation: composer-compact-squeeze-top 1.1s ease-in-out infinite;
  transform-origin: 12px 8px;
}

.composer-compact-icon.is-compacting .composer-compact-icon-bottom {
  animation: composer-compact-squeeze-bottom 1.1s ease-in-out infinite;
  transform-origin: 12px 16px;
}

@keyframes composer-compact-squeeze-top {
  0%, 100% { transform: translateY(-1px); }
  50% { transform: translateY(2px); }
}

@keyframes composer-compact-squeeze-bottom {
  0%, 100% { transform: translateY(1px); }
  50% { transform: translateY(-2px); }
}
</style>
