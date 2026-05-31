<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  conversationClientStateStreamId,
  type ConversationSettingsRecord,
  type GlobalSettingsRecord,
  type LlmProviderKind,
  type LlmSettingsRecord,
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isTextPart,
  isVisibleTextPart,
  type MessageRecord,
  type MsgRole,
  type TextPart,
  type ToolCallEventRecord,
  type ToolCallRecord
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '../bridge/vscodeBridge';
import { applyClientPatch, applyClientSnapshot, clientState } from '../stores/clientStateStore';

const input = ref('');
const scroller = ref<HTMLElement | null>(null);
const viewKind = ref<'chat' | 'globalSettings'>('chat');
const conversationSettingsOpen = ref(false);
const conversationSettingsStatus = ref('');
const settingsStatus = ref('');
const globalSettingsPath = ref('');
const llmSettingsPath = ref('');
const disposers: Array<() => void> = [];
const requestedConversationStreams = new Set<string>();
const requestedConversationSettings = new Set<string>();

const providerOptions: Array<{ value: LlmProviderKind; label: string }> = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' }
];

const globalSettings = reactive<GlobalSettingsRecord>({
  dataFilePath: '',
  activeDataRootPath: '',
  defaultDataRootPath: ''
});

const llmSettings = reactive<LlmSettingsRecord>({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    apiKey: '',
    proxy: '',
    temperature: 0.2
});

const conversationSettings = reactive<ConversationSettingsRecord>({
  conversationId: '',
  name: ''
});

const currentSession = computed(() =>
  clientState.sessions.find((session) => session.id === clientState.currentSessionId)
);

const sessionMessages = computed(() =>
  clientState.messages
    .filter((message) => message.conversationId === clientState.currentSessionId && !isToolResponseMessage(message))
    .sort((a, b) => a.seq - b.seq)
);

const activeAgentLink = computed(() =>
  clientState.agentConversationLinks.find((link) => link.conversationId === clientState.currentSessionId && link.role === 'default')
    ?? clientState.agentConversationLinks.find((link) => link.conversationId === clientState.currentSessionId)
);

const currentAgent = computed(() =>
  clientState.agents.find((agent) => agent.id === activeAgentLink.value?.agentId)
);

const activeModeLink = computed(() =>
  clientState.agentModeLinks.find((link) => link.agentId === currentAgent.value?.id && link.role === 'active')
    ?? clientState.agentModeLinks.find((link) => link.agentId === currentAgent.value?.id && link.role === 'default')
    ?? clientState.agentModeLinks.find((link) => link.agentId === currentAgent.value?.id)
);

const currentMode = computed(() =>
  clientState.agentModes.find((mode) => mode.id === activeModeLink.value?.modeId)
);

const currentModelProfileLink = computed(() =>
  clientState.modeModelProfileLinks.find((link) => link.modeId === currentMode.value?.id && link.role === 'active')
);

const currentModelProfile = computed(() =>
  clientState.modelProfiles.find((profile) => profile.id === currentModelProfileLink.value?.modelProfileId)
);

function toolCallsForMessage(messageId: string) {
  return clientState.toolCalls.filter((toolCall) => toolCall.messageId === messageId);
}

function eventsForToolCall(toolCallId: string) {
  return clientState.toolCallEvents.filter((event) => event.toolCallId === toolCallId).sort((a, b) => a.seq - b.seq);
}

function outputEventsForToolCall(toolCallId: string): ToolCallEventRecord[] {
  return eventsForToolCall(toolCallId).filter((event) => event.kind === 'stdout' || event.kind === 'stderr');
}

function toolOutputDelta(event: ToolCallEventRecord): string {
  return event.delta ?? (event.payload !== undefined ? stringifyPartPayload(event.payload) : '');
}

function messageDisplayText(message: MessageRecord): string {
  return message.content.parts.map((part) => {
    if (isVisibleTextPart(part)) return part.text;
    // functionCall 由下面的工具卡片渲染，不再混入正文，避免“执行工具前”重复显示 [tool call] 文本。
    if (isFunctionCallPart(part)) return '';
    if (isFunctionResponsePart(part)) return `\n[tool result] ${part.functionResponse.name}: ${stringifyPartPayload(part.functionResponse.response)}`;
    if (isFileDataPart(part)) return `\n[file] ${part.fileData.uri}`;
    if (isInlineDataPart(part)) return `\n[inline data] ${part.inlineData.mimeType}`;
    return '';
  }).join('').trimStart();
}

function isToolResponseMessage(message: MessageRecord): boolean {
  return message.content.parts.some(isFunctionResponsePart);
}

function thoughtParts(message: MessageRecord): TextPart[] {
  return message.content.parts.filter((part): part is TextPart =>
    isTextPart(part) && part.thought === true && part.text.trim().length > 0
  );
}

function thoughtSummary(message: MessageRecord): string {
  const parts = thoughtParts(message);
  if (parts.length === 0) return '';
  const totalDuration = parts.reduce((sum, part) => sum + (part.thoughtDurationMs ?? 0), 0);
  const duration = totalDuration > 0 ? ` · ${formatDuration(totalDuration)}` : '';
  return parts.length === 1 ? `思考${duration}` : `思考 ${parts.length} 段${duration}`;
}

function thoughtPartTitle(part: TextPart, index: number, total: number): string {
  const prefix = total > 1 ? `思考 ${index + 1}` : '思考内容';
  return part.thoughtDurationMs !== undefined ? `${prefix} · ${formatDuration(part.thoughtDurationMs)}` : prefix;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function stringifyPartPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolStatusLabel(status: ToolCallRecord['status']): string {
  const labels: Record<ToolCallRecord['status'], string> = {
    streaming: '生成参数',
    queued: '已排队',
    awaiting_approval: '等待批准',
    executing: '执行中',
    awaiting_apply: '等待应用',
    success: '成功',
    warning: '警告',
    error: '失败'
  };
  return labels[status];
}

function hasToolDetails(tool: ToolCallRecord): boolean {
  return tool.result !== undefined || !!tool.error || tool.progress !== undefined || eventsForToolCall(tool.id).length > 0;
}

function hasToolOutput(tool: ToolCallRecord): boolean {
  return outputEventsForToolCall(tool.id).some((event) => toolOutputDelta(event).length > 0);
}

function toolDetailText(tool: ToolCallRecord): string {
  const lines: string[] = [];
  if (tool.progress !== undefined) lines.push(`progress: ${stringifyPartPayload(tool.progress)}`);
  if (tool.result !== undefined) lines.push(`result: ${stringifyPartPayload(tool.result)}`);
  if (tool.error) lines.push(`error: ${tool.error}`);
  for (const event of eventsForToolCall(tool.id)) {
    lines.push(`[${event.seq}] ${event.kind}${event.status ? ` → ${event.status}` : ''}${event.durationMs !== undefined ? ` (${event.durationMs}ms)` : ''}`);
    const isOutput = event.kind === 'stdout' || event.kind === 'stderr';
    if (event.delta && !isOutput) lines.push(event.delta);
    if (event.payload !== undefined && !isOutput) lines.push(stringifyPartPayload(event.payload));
    if (event.error) lines.push(`error: ${event.error}`);
  }
  return lines.join('\n');
}

function canExecuteTool(tool: ToolCallRecord): boolean {
  return tool.status === 'awaiting_approval' && !!currentAgent.value?.id && !!currentMode.value?.id && !!clientState.currentSessionId;
}

function executeTool(tool: ToolCallRecord): void {
  if (!canExecuteTool(tool) || !currentAgent.value || !currentMode.value) return;
  bridge.request(BridgeMessageType.ToolExecute, {
    toolCallId: tool.id,
    conversationId: clientState.currentSessionId
  });
}

function send(): void {
  const text = input.value.trim();
  if (!text || !clientState.currentSessionId) return;
  bridge.request(BridgeMessageType.ChatSend, { conversationId: clientState.currentSessionId, text });
  input.value = '';
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

function resync(): void {
  if (clientState.currentSessionId) {
    const streamId = conversationClientStateStreamId(clientState.currentSessionId);
    bridge.request(BridgeMessageType.ClientResync, { conversationId: clientState.currentSessionId, streamId });
  } else {
    bridge.request(BridgeMessageType.ClientResync, {});
  }
}

function ensureConversationStream(sessionId: string): void {
  const streamId = conversationClientStateStreamId(sessionId);
  if (requestedConversationStreams.has(streamId)) return;
  requestedConversationStreams.add(streamId);
  bridge.request(BridgeMessageType.ClientResync, { conversationId: sessionId, streamId });
}

function ensureConversationSettings(sessionId: string): void {
  if (!sessionId || requestedConversationSettings.has(sessionId)) return;
  requestedConversationSettings.add(sessionId);
  requestConversationSettings(sessionId);
}

function requestConversationSettings(sessionId = clientState.currentSessionId): void {
  if (!sessionId) return;
  conversationSettingsStatus.value = '正在读取对话设置...';
  bridge.request(BridgeMessageType.ConversationSettingsGet, { conversationId: sessionId, section: 'common' });
}

function saveConversationSettings(): void {
  if (!conversationSettings.conversationId) return;
  conversationSettingsStatus.value = '正在保存对话设置...';
  bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
    section: 'common',
    settings: {
      conversationId: conversationSettings.conversationId,
      name: conversationSettings.name
    }
  });
}

function requestGlobalSettings(): void {
  settingsStatus.value = '正在读取设置...';
  bridge.request(BridgeMessageType.GlobalSettingsGet, { section: 'common' });
}

function requestLlmSettings(): void {
  settingsStatus.value = '正在读取设置...';
  bridge.request(BridgeMessageType.GlobalSettingsGet, { section: 'llm' });
}

function requestAllGlobalSettings(): void {
  requestGlobalSettings();
  requestLlmSettings();
}

function saveGlobalSettings(): void {
  settingsStatus.value = '正在保存设置，并按需迁移、删除旧数据目录中的插件数据...';
  bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
    section: 'common',
    settings: {
      dataFilePath: globalSettings.dataFilePath,
      activeDataRootPath: globalSettings.activeDataRootPath,
      defaultDataRootPath: globalSettings.defaultDataRootPath
    }
  });
}

function saveLlmSettings(): void {
  settingsStatus.value = '正在保存设置...';
  bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
    section: 'llm',
    settings: {
      provider: llmSettings.provider,
      baseUrl: llmSettings.baseUrl,
      model: llmSettings.model,
      apiKey: llmSettings.apiKey,
      ...(llmSettings.proxy?.trim() ? { proxy: llmSettings.proxy.trim() } : {}),
      temperature: Number(llmSettings.temperature)
    }
  });
}

function applyGlobalSettings(settings: GlobalSettingsRecord): void {
  globalSettings.dataFilePath = settings.dataFilePath;
  globalSettings.activeDataRootPath = settings.activeDataRootPath;
  globalSettings.defaultDataRootPath = settings.defaultDataRootPath;
}

function applyLlmSettings(settings: LlmSettingsRecord): void {
  llmSettings.provider = settings.provider;
  llmSettings.baseUrl = settings.baseUrl;
  llmSettings.model = settings.model;
  llmSettings.apiKey = settings.apiKey;
  llmSettings.proxy = settings.proxy ?? '';
  llmSettings.temperature = settings.temperature;
}

function applyConversationSettings(settings: ConversationSettingsRecord): void {
  conversationSettings.conversationId = settings.conversationId;
  conversationSettings.name = settings.name;
}

function roleLabel(role: MsgRole): string {
  return role === 'user' ? '你' : '助手';
}

function scrollToBottom(): void {
  void nextTick(() => {
    const element = scroller.value;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    element.querySelectorAll<HTMLElement>('.tool-output').forEach((output) => {
      output.scrollTop = output.scrollHeight;
    });
  });
}

watch(() => sessionMessages.value.reduce((acc, message) => acc + messageDisplayText(message).length, sessionMessages.value.length), scrollToBottom);

watch(() => {
  const messageIds = new Set(sessionMessages.value.map((message) => message.id));
  const toolCallIds = new Set(clientState.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId)).map((toolCall) => toolCall.id));
  return clientState.toolCallEvents
    .filter((event) => toolCallIds.has(event.toolCallId))
    .reduce((acc, event) => acc + (event.delta?.length ?? 0), clientState.toolCallEvents.length);
}, scrollToBottom);

watch(
  () => clientState.currentSessionId,
  (sessionId) => {
    if (viewKind.value !== 'chat' || !sessionId) return;
    ensureConversationStream(sessionId);
    ensureConversationSettings(sessionId);
    if (!conversationSettings.conversationId) {
      conversationSettings.conversationId = sessionId;
      conversationSettings.name = currentSession.value?.title || sessionId;
    }
  }
);

watch(
  () => currentSession.value?.title,
  (title) => {
    if (viewKind.value !== 'chat' || !clientState.currentSessionId) return;
    if (!conversationSettings.name || conversationSettings.name === conversationSettings.conversationId) {
      conversationSettings.conversationId = clientState.currentSessionId;
      conversationSettings.name = title || clientState.currentSessionId;
    }
  }
);

onMounted(() => {
  disposers.push(
    bridge.on(BridgeMessageType.Hello, (message) => {
      const meta = message.payload?.meta;
      viewKind.value = meta?.kind === 'globalSettings' ? 'globalSettings' : 'chat';
      if (viewKind.value === 'globalSettings') {
        requestAllGlobalSettings();
        return;
      }

      const conversationId = meta?.conversationId;
      if (!conversationId) return;
      clientState.currentSessionId = conversationId;
      conversationSettings.conversationId = conversationId;
      conversationSettings.name = currentSession.value?.title || conversationId;
      ensureConversationStream(conversationId);
      ensureConversationSettings(conversationId);
    })
  );
  disposers.push(
    bridge.on(BridgeMessageType.ClientSnapshot, (message) => {
      if (!message.payload) return;
      applyClientSnapshot(message.payload.streamId, message.payload.streamSeq, message.payload.state);
    })
  );
  disposers.push(
    bridge.on(BridgeMessageType.ClientPatch, (message) => {
      if (!message.payload) return;
      if (!applyClientPatch(message.payload.streamId, message.payload.streamSeq, message.payload.patches)) resync();
    })
  );
  disposers.push(
    bridge.on(BridgeMessageType.GlobalSettingsSnapshot, (message) => {
      if (!message.payload) return;
      if (message.payload.section === 'llm') {
        applyLlmSettings(message.payload.settings as LlmSettingsRecord);
        llmSettingsPath.value = message.payload.filePath;
      } else {
        applyGlobalSettings(message.payload.settings as GlobalSettingsRecord);
        globalSettingsPath.value = message.payload.filePath;
      }
      settingsStatus.value = '设置已同步';
    })
  );
  disposers.push(
    bridge.on(BridgeMessageType.ConversationSettingsSnapshot, (message) => {
      if (!message.payload) return;
      if (message.payload.section === 'common') {
        applyConversationSettings(message.payload.settings as ConversationSettingsRecord);
      }
      conversationSettingsStatus.value = '对话设置已同步';
    })
  );
  disposers.push(
    bridge.on(BridgeMessageType.Error, (message) => {
      if (message.payload?.requestType === BridgeMessageType.GlobalSettingsUpdate) {
        settingsStatus.value = `设置保存失败：${message.payload.message}`;
      }
    })
  );
  bridge.ready();
});

onBeforeUnmount(() => disposers.forEach((dispose) => dispose()));
</script>

<template>
  <div v-if="viewKind === 'globalSettings'" class="chat">
    <header class="chat-header">
      <div class="header-main">
        <span class="title">LimCode 全局设置</span>
        <span class="hint">LLM 设置属于全局配置，会同步给全局设置订阅者。</span>
      </div>
    </header>

    <section class="settings-panel global-settings-panel">
      <h2>全局配置</h2>
      <label>
        <span>数据目录路径（留空使用 VS Code 默认目录；保存后只迁移并删除旧目录中已注册的插件数据目录）</span>
        <input v-model="globalSettings.dataFilePath" type="text" placeholder="例如：D:/limcode/data" />
      </label>

      <h2>LLM 设置</h2>
      <div class="settings-grid">
        <label>
          <span>Provider</span>
          <select v-model="llmSettings.provider">
            <option v-for="option in providerOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label>
          <span>Base URL</span>
          <input v-model="llmSettings.baseUrl" type="text" placeholder="https://api.deepseek.com/v1" />
        </label>
        <label>
          <span>Model</span>
          <input v-model="llmSettings.model" type="text" placeholder="deepseek-v4-flash" />
        </label>
        <label>
          <span>Temperature</span>
          <input v-model.number="llmSettings.temperature" type="number" min="0" max="2" step="0.1" />
        </label>
        <label>
          <span>HTTP/HTTPS 代理（可选）</span>
          <input v-model="llmSettings.proxy" type="text" placeholder="例如：http://localhost:8000" />
        </label>
      </div>

      <label class="api-key-field">
        <span>API Key（明文显示 / 明文保存）</span>
        <input v-model="llmSettings.apiKey" type="text" placeholder="sk-..." autocomplete="off" spellcheck="false" />
      </label>

      <div class="settings-actions">
        <button type="button" @click="saveGlobalSettings">保存全局设置</button>
        <button type="button" @click="saveLlmSettings">保存 LLM 设置</button>
        <button type="button" class="secondary" @click="requestAllGlobalSettings">重新读取</button>
        <span class="settings-status">{{ settingsStatus }}</span>
      </div>

      <p class="settings-path">
        当前数据目录：<code>{{ globalSettings.activeDataRootPath || '等待后端返回当前数据目录...' }}</code>
      </p>
      <p class="settings-path">
        默认数据目录：<code>{{ globalSettings.defaultDataRootPath || '等待后端返回默认数据目录...' }}</code>
      </p>
      <p class="settings-path">
        路径配置保存位置：<code>{{ globalSettingsPath || '等待后端返回 VS Code globalState 位置...' }}</code>
      </p>
      <p class="settings-path">
        LLM 文件：<code>{{ llmSettingsPath || '等待后端返回 settings/llm.json 路径...' }}</code>
      </p>
    </section>
  </div>

  <div v-else class="chat">
    <header class="chat-header">
      <div class="header-main">
        <span class="title">LimCode AI</span>
        <span class="hint">
          <template v-if="clientState.currentSessionId">
            当前会话：<code>{{ currentSession?.title || clientState.currentSessionId }}</code>
            <template v-if="currentMode?.name"> · 模式：<code>{{ currentMode.name }}</code></template>
            <template v-if="currentModelProfile?.model"> · 模型：<code>{{ currentModelProfile.model }}</code></template>
          </template>
          <template v-else>正在初始化默认会话...</template>
        </span>
      </div>
      <button type="button" class="settings-toggle" @click="conversationSettingsOpen = !conversationSettingsOpen">
        {{ conversationSettingsOpen ? '收起对话设置' : '对话设置' }}
      </button>
    </header>

    <section v-if="conversationSettingsOpen" class="settings-panel">
      <h2>对话设置</h2>
      <div class="settings-grid single">
        <label>
          <span>对话名称</span>
          <input v-model="conversationSettings.name" type="text" placeholder="输入对话名称" />
        </label>
      </div>
      <div class="settings-actions">
        <button type="button" :disabled="!conversationSettings.conversationId" @click="saveConversationSettings">保存对话设置</button>
        <button type="button" class="secondary" :disabled="!clientState.currentSessionId" @click="requestConversationSettings()">重新读取</button>
        <span class="settings-status">{{ conversationSettingsStatus }}</span>
      </div>
      <p class="settings-note">对话级 common 设置会保存到当前 conversation 目录下的 <code>settings/common.json</code>。</p>
    </section>

    <div ref="scroller" class="messages">
      <div v-for="m in sessionMessages" :key="m.id" class="msg" :class="m.role">
        <div class="meta">{{ roleLabel(m.role) }}</div>
        <div class="bubble">
          <details v-if="thoughtParts(m).length" class="thoughts">
            <summary>{{ thoughtSummary(m) }}</summary>
            <div v-for="(thought, index) in thoughtParts(m)" :key="index" class="thought-block">
              <div class="thought-title">{{ thoughtPartTitle(thought, index, thoughtParts(m).length) }}</div>
              <pre class="thought-text">{{ thought.text }}</pre>
            </div>
          </details>
          <pre v-if="messageDisplayText(m) || m.status === 'streaming'" class="text">{{ messageDisplayText(m) }}<span v-if="m.status === 'streaming'" class="cursor">▋</span></pre>
          <div v-if="toolCallsForMessage(m.id).length" class="tools">
            <div v-for="t in toolCallsForMessage(m.id)" :key="t.id" class="tool" :class="t.status">
              <span class="tool-name">⚙ {{ t.name }}</span>
              <span class="tool-status">{{ toolStatusLabel(t.status) }}</span>
              <button v-if="canExecuteTool(t)" type="button" class="tool-action" @click="executeTool(t)">执行</button>
              <code class="tool-args">{{ t.args }}</code>
              <pre v-if="hasToolOutput(t)" class="tool-output" aria-live="polite"><span v-for="event in outputEventsForToolCall(t.id)" :key="event.id" class="tool-output-delta" :class="event.kind">{{ toolOutputDelta(event) }}</span></pre>
              <details v-if="hasToolDetails(t)" class="tool-details">
                <summary>详情</summary>
                <pre>{{ toolDetailText(t) }}</pre>
              </details>
            </div>
          </div>
        </div>
      </div>
      <p v-if="!sessionMessages.length" class="empty">
        {{ clientState.currentSessionId ? '还没有消息，发一条试试。' : '默认会话初始化中，请稍候。' }}
      </p>
    </div>

    <footer class="composer">
      <textarea v-model="input" rows="2" :placeholder="clientState.currentSessionId ? '输入消息，Enter 发送，Shift+Enter 换行' : '默认会话初始化中...'" @keydown="onKeydown"></textarea>
      <button type="button" :disabled="!input.trim() || !clientState.currentSessionId" @click="send">发送</button>
    </footer>
  </div>
</template>

<style scoped>
.chat { display: flex; flex-direction: column; height: 100vh; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
.chat-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
.header-main { min-width: 0; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.chat-header .title { font-weight: 600; }
.chat-header .hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
.settings-toggle { flex: 0 0 auto; padding: 5px 10px; font-size: 12px; }
h2 { margin: 0; font-size: 13px; }
code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 4px; }
.settings-panel { border-bottom: 1px solid var(--vscode-panel-border); padding: 12px 14px; background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%); display: flex; flex-direction: column; gap: 10px; }
.global-settings-panel { border-bottom: 0; margin: 14px; border: 1px solid var(--vscode-panel-border); border-radius: 10px; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.settings-grid.single { grid-template-columns: minmax(0, 1fr); }
.settings-panel label { display: flex; flex-direction: column; gap: 5px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.settings-panel input,
.settings-panel select { width: 100%; border-radius: 6px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; padding: 7px 8px; }
.api-key-field input { font-family: var(--vscode-editor-font-family, monospace); }
.settings-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.settings-actions button { padding: 6px 12px; }
.settings-actions .secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
.settings-status,
.settings-path,
.settings-note { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0; }
.settings-path code { word-break: break-all; }
.messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.msg { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
.msg .meta { font-size: 11px; color: var(--vscode-descriptionForeground); }
.msg.user { align-items: flex-end; }
.bubble { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 8px 12px; background: var(--vscode-editor-background); max-width: 90%; }
.msg.user .bubble { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.text { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; }
.thoughts { margin: 0 0 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.thoughts summary { cursor: pointer; user-select: none; }
.thought-block { margin-top: 6px; padding: 6px 8px; border-left: 2px solid var(--vscode-panel-border); background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%); }
.thought-title { margin-bottom: 4px; font-size: 11px; opacity: 0.9; }
.thought-text { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; }
.cursor { animation: blink 1s steps(2, start) infinite; }
@keyframes blink { to { opacity: 0; } }
.tools { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.tool { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); }
.tool .tool-status { text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
.tool-action { padding: 2px 8px; font-size: 11px; }
.tool.streaming,
.tool.queued,
.tool.executing,
.tool.awaiting_approval,
.tool.awaiting_apply { border-color: var(--vscode-progressBar-background); }
.tool.success { border-color: var(--vscode-testing-iconPassed, #3fb950); }
.tool.warning { border-color: var(--vscode-editorWarning-foreground, #d29922); }
.tool.error { border-color: var(--vscode-errorForeground); }
.tool-args { color: var(--vscode-descriptionForeground); }
.tool-output { flex-basis: 100%; width: 100%; max-height: 260px; overflow: auto; margin: 4px 0 0; padding: 8px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.45; }
.tool-output-delta.stdout { color: var(--vscode-foreground); }
.tool-output-delta.stderr { color: var(--vscode-errorForeground); }
.tool-details { flex-basis: 100%; color: var(--vscode-descriptionForeground); }
.tool-details summary { cursor: pointer; }
.tool-details pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; }
.empty { color: var(--vscode-descriptionForeground); text-align: center; margin-top: 40px; }
.composer { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--vscode-panel-border); }
.composer textarea { flex: 1; resize: none; border-radius: 6px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; padding: 8px; }
.composer button { align-self: flex-end; border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font: inherit; }
.composer button:disabled { opacity: 0.5; cursor: default; }
.composer button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
@media (max-width: 640px) {
  .settings-grid { grid-template-columns: 1fr; }
}
</style>
