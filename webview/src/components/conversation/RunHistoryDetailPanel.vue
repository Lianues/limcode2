<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconCheck, IconCopy, IconEye, IconEyeOff } from '@tabler/icons-vue';
import { isVisibleTextPart, type AgentRunStatus, type MessageRecord, type ToolCallRecord } from '@shared/protocol';
import { useRunHistoryStore } from '@webview/stores/useRunHistoryStore';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

const runHistory = useRunHistoryStore();
const detailScroller = ref<HTMLElement | null>(null);
const curlCopied = ref(false);
const detailCopied = ref(false);
const apiKeyCopied = ref(false);
const curlOpen = ref(false);
const rawDetailOpen = ref(false);
const includeApiKey = ref(false);

const activeDetail = computed(() => runHistory.activeDetailRecord);
const activeSummary = computed(() => runHistory.activeDetailSummary ?? activeDetail.value?.summary);
const activeState = computed(() => activeDetail.value?.state);
const activeConversationState = computed(() => runHistory.activeDetailState);
const loading = computed(() => activeConversationState.value?.status === 'loadingDetail' && !activeDetail.value);
const error = computed(() => activeConversationState.value?.error);
const run = computed(() => activeState.value?.agentRuns[0]);
const inputMessages = computed(() => messagesForRoles(['input']));
const outputMessages = computed(() => messagesForRoles(['model', 'tool_response', 'notification']));
const toolCalls = computed(() => activeState.value?.toolCalls ?? []);
const detailJson = computed(() => rawDetailOpen.value && activeDetail.value ? JSON.stringify(activeDetail.value.state, null, 2) : '');
const dryRun = computed(() => runHistory.activeDryRun);
const dryRunLoading = computed(() => runHistory.activeDryRunLoading);
const dryRunError = computed(() => runHistory.activeDryRunError);
const activeKey = computed(() => runHistory.activeDetail ? `${runHistory.activeDetail.conversationId}:${runHistory.activeDetail.runId}` : '');
const apiKeyHeader = computed(() => sensitiveHeader(dryRun.value?.headers));
const apiKeyValue = computed(() => includeApiKey.value ? apiKeyHeader.value?.value ?? '' : '••••••••');
const displayCurl = computed(() => includeApiKey.value ? dryRun.value?.curl ?? '' : dryRun.value?.maskedCurl ?? dryRun.value?.curl ?? '');

watch(activeKey, () => {
  curlOpen.value = false;
  rawDetailOpen.value = false;
  includeApiKey.value = false;
  curlCopied.value = false;
  detailCopied.value = false;
  apiKeyCopied.value = false;
});

function close(): void {
  runHistory.closeDetail();
}

function toggleCurlOpen(): void {
  curlOpen.value = !curlOpen.value;
  if (curlOpen.value) ensureDryRun();
}

function toggleRawDetailOpen(): void {
  rawDetailOpen.value = !rawDetailOpen.value;
}

function toggleApiKeyVisibility(): void {
  includeApiKey.value = !includeApiKey.value;
}

function ensureDryRun(): void {
  const active = runHistory.activeDetail;
  if (!active) return;
  if (dryRunLoading.value) return;
  if (dryRun.value) return;
  // 提前获取包含真实 key + maskedCurl 的 dry-run；显示/隐藏只在前端本地切换，避免重复请求造成抖动。
  runHistory.requestDryRun(active.conversationId, active.runId, true);
}

async function copyCurl(): Promise<void> {
  await copyText(displayCurl.value, curlCopied, '[LimCode] Failed to copy dry-run curl.');
}

async function copyDetail(): Promise<void> {
  await copyText(detailJson.value, detailCopied, '[LimCode] Failed to copy run detail.');
}

async function copyApiKey(): Promise<void> {
  await copyText(includeApiKey.value ? apiKeyHeader.value?.value ?? '' : '', apiKeyCopied, '[LimCode] Failed to copy API key.');
}

async function copyText(text: string, copiedRef: typeof curlCopied, warning: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copiedRef.value = true;
    window.setTimeout(() => { copiedRef.value = false; }, 1200);
  } catch (error) {
    console.warn(warning, error);
  }
}

function messagesForRoles(roles: string[]): MessageRecord[] {
  const state = activeState.value;
  if (!state) return [];
  const roleSet = new Set(roles);
  const ids = new Set(state.messageRunLinks.filter((link) => roleSet.has(link.role)).map((link) => link.messageId));
  return state.messages.filter((message) => ids.has(message.id)).sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt);
}

function messagePreview(message: MessageRecord): string {
  const text = message.content.parts
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) return text;
  return message.content.parts.some((part) => 'functionCall' in part)
    ? '工具调用消息'
    : message.content.parts.some((part) => 'functionResponse' in part)
      ? '工具响应消息'
      : '空消息';
}

function toolCallLabel(toolCall: ToolCallRecord): string {
  return `${toolCall.name} · ${toolCall.status}`;
}

function formatTime(value: number | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function statusLabel(status: AgentRunStatus | undefined): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'preparing': return '准备中';
    case 'running': return '执行中';
    case 'waiting_tool': return '等待工具';
    case 'waiting_child_run': return '等待子任务';
    case 'delivering': return '整理回复';
    case 'paused': return '已暂停';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'cancelled': return '已终止';
    case 'stale': return '已过期';
    default: return '未知';
  }
}

function sensitiveHeader(headers: Record<string, string> | undefined): { name: string; value: string } | undefined {
  if (!headers) return undefined;
  const sensitiveNames = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'api-key', 'openai-key']);
  for (const [name, value] of Object.entries(headers)) {
    if (sensitiveNames.has(name.toLowerCase())) return { name, value };
  }
  return undefined;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="runHistory.detailPanelOpen" class="run-detail-backdrop" @click.self="close">
      <section class="run-detail-panel" role="dialog" aria-modal="true" aria-label="LLM 调用详情">
        <header class="run-detail-header">
          <h2 class="run-detail-title">
            <IconEye class="run-detail-title-icon" stroke="2" aria-hidden="true" />
            <span>LLM 调用详情</span>
          </h2>
          <button type="button" class="run-detail-close" aria-label="关闭" title="关闭" @click="close">×</button>
        </header>

        <div class="run-detail-body-shell">
          <div ref="detailScroller" class="run-detail-body">
            <p v-if="loading" class="run-detail-empty">正在加载本次调用详情...</p>
            <p v-else-if="error && !activeDetail" class="run-detail-empty is-error">{{ error }}</p>
            <template v-else-if="activeDetail">
              <section class="run-detail-section">
                <h3>概要</h3>
                <dl class="run-detail-grid">
                  <div><dt>Run ID</dt><dd>{{ activeDetail.runId }}</dd></div>
                  <div><dt>状态</dt><dd>{{ statusLabel(run?.status) }}</dd></div>
                  <div><dt>类型</dt><dd>{{ run?.kind ?? '—' }}</dd></div>
                  <div><dt>创建时间</dt><dd>{{ formatTime(run?.createdAt) }}</dd></div>
                  <div><dt>更新时间</dt><dd>{{ formatTime(run?.updatedAt) }}</dd></div>
                  <div><dt>完成时间</dt><dd>{{ formatTime(run?.completedAt) }}</dd></div>
                  <div><dt>目标 Agent</dt><dd>{{ activeSummary?.targetAgentId ?? '—' }}</dd></div>
                  <div><dt>目标对话</dt><dd>{{ activeSummary?.targetConversationId ?? activeDetail.conversationId }}</dd></div>
                </dl>
              </section>

              <section v-if="inputMessages.length" class="run-detail-section">
                <h3>输入消息</h3>
                <article v-for="message in inputMessages" :key="message.id" class="run-detail-message">
                  <span class="run-detail-message-meta">{{ message.role }} · #{{ message.seq }}</span>
                  <p>{{ messagePreview(message) }}</p>
                </article>
              </section>

              <section v-if="outputMessages.length" class="run-detail-section">
                <h3>输出消息</h3>
                <article v-for="message in outputMessages" :key="message.id" class="run-detail-message">
                  <span class="run-detail-message-meta">{{ message.role }} · #{{ message.seq }} · {{ message.status }}</span>
                  <p>{{ messagePreview(message) }}</p>
                </article>
              </section>

              <section v-if="toolCalls.length" class="run-detail-section">
                <h3>工具调用</h3>
                <article v-for="toolCall in toolCalls" :key="toolCall.id" class="run-detail-message">
                  <span class="run-detail-message-meta">{{ toolCall.id }}</span>
                  <p>{{ toolCallLabel(toolCall) }}</p>
                </article>
              </section>

              <section class="run-detail-section">
                <div class="run-detail-section-head">
                  <h3>真实 LLM 请求 dry-run</h3>
                  <div class="run-detail-head-actions">
                    <button
                      type="button"
                      class="run-detail-icon-button"
                      :title="curlOpen ? '隐藏 curl' : '显示 curl'"
                      :aria-label="curlOpen ? '隐藏 curl' : '显示 curl'"
                      @click="toggleCurlOpen"
                    >
                      <IconEye v-if="curlOpen" stroke="2" aria-hidden="true" />
                      <IconEyeOff v-else stroke="2" aria-hidden="true" />
                    </button>
                    <button
                      v-if="curlOpen && dryRun?.curl"
                      type="button"
                      class="run-detail-copy"
                      :title="curlCopied ? '已复制' : '复制 curl'"
                      :aria-label="curlCopied ? '已复制 curl' : '复制 curl'"
                      @click="copyCurl"
                    >
                      <IconCheck v-if="curlCopied" stroke="2" aria-hidden="true" />
                      <IconCopy v-else stroke="2" aria-hidden="true" />
                      <span>{{ curlCopied ? '已复制' : '复制' }}</span>
                    </button>
                  </div>
                </div>
                <template v-if="curlOpen">
                  <p v-if="dryRunLoading" class="run-detail-empty">正在通过 unified-llm-provider dry-run 构建 curl...</p>
                  <p v-else-if="dryRunError" class="run-detail-empty is-error">{{ dryRunError }}</p>
                  <template v-else-if="dryRun">
                    <dl class="run-detail-grid run-detail-dryrun-meta">
                      <div><dt>Provider</dt><dd>{{ dryRun.provider ?? '—' }}</dd></div>
                      <div><dt>Model</dt><dd>{{ dryRun.model ?? '—' }}</dd></div>
                      <div><dt>URL</dt><dd>{{ dryRun.url }}</dd></div>
                      <div>
                        <dt class="run-detail-api-key-title">
                          <span>API Key</span>
                          <button
                            type="button"
                            class="run-detail-inline-icon-button"
                            :title="includeApiKey ? '隐藏 API Key' : '显示 API Key'"
                            :aria-label="includeApiKey ? '隐藏 API Key' : '显示 API Key'"
                            @click="toggleApiKeyVisibility"
                          >
                            <IconEye v-if="includeApiKey" stroke="2" aria-hidden="true" />
                            <IconEyeOff v-else stroke="2" aria-hidden="true" />
                          </button>
                          <button
                            v-if="includeApiKey && apiKeyValue"
                            type="button"
                            class="run-detail-inline-icon-button"
                            :title="apiKeyCopied ? '已复制 API Key' : '复制 API Key'"
                            :aria-label="apiKeyCopied ? '已复制 API Key' : '复制 API Key'"
                            @click="copyApiKey"
                          >
                            <IconCheck v-if="apiKeyCopied" stroke="2" aria-hidden="true" />
                            <IconCopy v-else stroke="2" aria-hidden="true" />
                          </button>
                        </dt>
                        <dd class="run-detail-api-key-value" :class="{ 'is-visible': includeApiKey }">
                          {{ includeApiKey ? apiKeyValue || '未在请求 header 中找到 API Key' : '已隐藏（点击闭眼按钮显示）' }}
                        </dd>
                      </div>
                    </dl>
                    <pre class="run-detail-json run-detail-curl">{{ displayCurl }}</pre>
                  </template>
                  <p v-else class="run-detail-empty">点击眼睛后会构建 dry-run curl，不发送网络请求。</p>
                </template>
                <p v-else class="run-detail-empty">curl 默认隐藏，点击闭眼按钮后再构建并显示。</p>
              </section>

              <section class="run-detail-section">
                <div class="run-detail-section-head">
                  <h3>原始对话详情</h3>
                  <div class="run-detail-head-actions">
                    <button
                      type="button"
                      class="run-detail-icon-button"
                      :title="rawDetailOpen ? '隐藏原始详情' : '显示原始详情'"
                      :aria-label="rawDetailOpen ? '隐藏原始详情' : '显示原始详情'"
                      @click="toggleRawDetailOpen"
                    >
                      <IconEye v-if="rawDetailOpen" stroke="2" aria-hidden="true" />
                      <IconEyeOff v-else stroke="2" aria-hidden="true" />
                    </button>
                    <button
                      v-if="rawDetailOpen && detailJson"
                      type="button"
                      class="run-detail-copy"
                      :title="detailCopied ? '已复制' : '复制原始详情'"
                      :aria-label="detailCopied ? '已复制原始详情' : '复制原始详情'"
                      @click="copyDetail"
                    >
                      <IconCheck v-if="detailCopied" stroke="2" aria-hidden="true" />
                      <IconCopy v-else stroke="2" aria-hidden="true" />
                      <span>{{ detailCopied ? '已复制' : '复制' }}</span>
                    </button>
                  </div>
                </div>
                <pre v-if="rawDetailOpen" class="run-detail-json">{{ detailJson }}</pre>
                <p v-else class="run-detail-empty">原始详情默认隐藏，点击闭眼按钮后再渲染。</p>
              </section>

            </template>
            <p v-else class="run-detail-empty">暂无可展示的调用详情。</p>
          </div>
          <AdvancedScrollbar :scroller="detailScroller" />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.run-detail-backdrop {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: rgba(0, 0, 0, 0.48);
  animation: lc-dialog-backdrop-in var(--lc-dialog-backdrop-in-duration) ease-out;
}

.run-detail-panel {
  width: min(760px, 100%);
  max-height: min(82vh, 760px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
  animation: lc-dialog-panel-in var(--lc-dialog-panel-in-duration) var(--lc-dialog-panel-ease);
}

.run-detail-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
}

.run-detail-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: calc(var(--font-size-lg) + 2px);
  font-weight: 650;
}

.run-detail-title-icon {
  width: 20px;
  height: 20px;
  color: var(--vscode-descriptionForeground);
}

.run-detail-close {
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.run-detail-close:hover,
.run-detail-close:focus-visible {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.run-detail-body-shell {
  position: relative;
  min-height: 0;
  flex: 1;
}

.run-detail-body {
  max-height: calc(min(82vh, 760px) - 58px);
  overflow-y: auto;
  padding: var(--space-4) calc(var(--space-4) + 18px) var(--space-4) var(--space-4);
  scrollbar-width: none;
}

.run-detail-body::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.run-detail-section + .run-detail-section {
  margin-top: var(--space-4);
}

.run-detail-section h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-md);
  font-weight: 650;
}

.run-detail-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}

.run-detail-section-head h3 {
  margin: 0;
}

.run-detail-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.run-detail-icon-button,
.run-detail-copy {
  min-width: 28px;
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  cursor: pointer;
}

.run-detail-icon-button {
  width: 28px;
  height: 28px;
  padding: 0;
}

.run-detail-icon-button :deep(svg) {
  width: 16px;
  height: 16px;
}

.run-detail-copy {
  gap: 4px;
  padding: 0 8px;
  font-size: var(--font-size-xs);
  line-height: 1;
}

.run-detail-copy :deep(svg) {
  width: 14px;
  height: 14px;
}

.run-detail-icon-button:hover,
.run-detail-icon-button:focus-visible,
.run-detail-copy:hover,
.run-detail-copy:focus-visible {
  color: var(--vscode-button-foreground, var(--vscode-foreground));
  border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
  background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 76%, var(--vscode-foreground) 24%));
  outline: none;
}

.run-detail-icon-button:active,
.run-detail-copy:active {
  transform: translateY(1px);
}


.run-detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-2);
  margin: 0;
}

.run-detail-api-key-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.run-detail-inline-icon-button {
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
}

.run-detail-inline-icon-button :deep(svg) {
  width: 14px;
  height: 14px;
}

.run-detail-inline-icon-button:hover,
.run-detail-inline-icon-button:focus-visible {
  color: var(--vscode-foreground);
  background: transparent;
  outline: none;
}

.run-detail-api-key-value {
  overflow-wrap: anywhere;
}

.run-detail-api-key-value.is-visible {
  color: var(--vscode-errorForeground, var(--vscode-foreground));
}


.run-detail-grid div {
  min-width: 0;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
}

.run-detail-grid dt {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.run-detail-grid dd {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--font-size-sm);
}

.run-detail-message {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.run-detail-message + .run-detail-message {
  margin-top: var(--space-2);
}

.run-detail-message-meta {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  font-family: var(--vscode-editor-font-family, monospace);
}

.run-detail-message p {
  margin: 4px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.run-detail-json {
  margin: 0;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--font-size-xs);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.run-detail-curl {
  margin-top: var(--space-2);
}

.run-detail-dryrun-meta {
  margin-bottom: var(--space-2);
}

.run-detail-empty {
  margin: 0;
  color: var(--vscode-descriptionForeground);
}

.run-detail-empty.is-error {
  color: var(--vscode-errorForeground);
}
</style>
