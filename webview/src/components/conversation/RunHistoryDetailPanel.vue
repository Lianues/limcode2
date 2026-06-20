<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconCheck, IconCopy, IconEye, IconEyeOff, IconX } from '@tabler/icons-vue';
import {
  isFunctionCallPart,
  isFunctionResponsePart,
  isVisibleTextPart,
  type AgentRunStatus,
  type ContentPart,
  type LlmInvocationRecord,
  type MessageRecord,
  type ToolCallRecord,
  type ToolCallStatus
} from '@shared/protocol';
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
const detailJson = computed(() => rawDetailOpen.value && activeDetail.value ? JSON.stringify(activeDetail.value.state, null, 2) : '');
const dryRun = computed(() => runHistory.activeDryRun);
const dryRunLoading = computed(() => runHistory.activeDryRunLoading);
const dryRunError = computed(() => runHistory.activeDryRunError);
const selectedMessageId = computed(() => runHistory.activeDetail?.messageId);
const selectedMessage = computed(() => activeState.value?.messages.find((message) => message.id === selectedMessageId.value));
const selectedInvocation = computed(() => selectActiveInvocation());
const selectedInvocationSettings = computed(() => selectedInvocation.value?.settings);
const activeKey = computed(() => runHistory.activeDetail ? `${runHistory.activeDetail.conversationId}:${runHistory.activeDetail.runId ?? ''}:${runHistory.activeDetail.messageId ?? ''}:${selectedInvocation.value?.id ?? ''}` : '');
const invocationGenerationConfigJson = computed(() => selectedInvocationSettings.value?.generationConfig ? stringifyJson(selectedInvocationSettings.value.generationConfig) : '');
const invocationRequestBodyJson = computed(() => selectedInvocationSettings.value?.requestBody ? stringifyJson(selectedInvocationSettings.value.requestBody) : '');
const invocationHeadersJson = computed(() => selectedInvocationSettings.value?.headers ? stringifyJson(selectedInvocationSettings.value.headers) : '');
const invocationUsageJson = computed(() => selectedInvocation.value?.usageMetadata ? stringifyJson(selectedInvocation.value.usageMetadata) : '');
const selectedToolCallIdentity = computed(() => {
  const message = selectedMessage.value;
  const ids = new Set<string>();
  const names = new Set<string>();
  if (!message) return { ids, names };

  for (const part of toolParts(message)) {
    if (!isFunctionCallPart(part)) continue;
    names.add(part.functionCall.name);
    if (part.id) ids.add(part.id);
    const call = toolCallForPart(message, part);
    if (call) {
      ids.add(call.id);
      if (call.functionCallId) ids.add(call.functionCallId);
      names.add(call.name);
    }
  }
  return { ids, names };
});
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
  const invocationId = selectedInvocation.value?.id;
  const key = invocationId ?? active.runId ?? active.messageId;
  const state = runHistory.conversationRunHistory(active.conversationId);
  if (key && (state.dryRunLoadingByRunId[key] || state.dryRunByRunId[key])) return;
  // 提前获取包含真实 key + maskedCurl 的 dry-run；显示/隐藏只在前端本地切换，避免重复请求造成抖动。
  runHistory.requestDryRun(active.conversationId, active.runId, true, active.messageId, invocationId);
}

function selectActiveInvocation(): LlmInvocationRecord | undefined {
  const state = activeState.value;
  if (!state) return undefined;
  const byId = new Map(state.llmInvocations.map((invocation) => [invocation.id, invocation]));

  const messageId = selectedMessageId.value;
  if (messageId) {
    const messageLink = state.messageLlmInvocationLinks.find((link) => link.messageId === messageId);
    const invocation = messageLink ? byId.get(messageLink.invocationId) : undefined;
    if (invocation) return invocation;
  }

  const runId = activeDetail.value?.runId;
  if (!runId) return [...byId.values()].sort(compareInvocationsByCreatedAtDesc)[0];
  return state.runLlmInvocationLinks
    .filter((link) => link.runId === runId)
    .map((link) => byId.get(link.invocationId))
    .filter((invocation): invocation is LlmInvocationRecord => invocation !== undefined)
    .sort(compareInvocationsByCreatedAtDesc)[0];
}

function compareInvocationsByCreatedAtDesc(left: LlmInvocationRecord, right: LlmInvocationRecord): number {
  return right.createdAt - left.createdAt || right.id.localeCompare(left.id);
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

function isSelectedDetailMessage(message: MessageRecord): boolean {
  return !!selectedMessageId.value && message.id === selectedMessageId.value;
}

function isRelatedToolOutputMessage(message: MessageRecord): boolean {
  if (isSelectedDetailMessage(message)) return false;
  const identity = selectedToolCallIdentity.value;
  if (identity.ids.size === 0 && identity.names.size === 0) return false;

  for (const part of message.content.parts) {
    if (!isFunctionResponsePart(part)) continue;
    const call = toolCallForPart(message, part);
    if (part.id && identity.ids.has(part.id)) return true;
    if (call && (identity.ids.has(call.id) || (call.functionCallId !== undefined && identity.ids.has(call.functionCallId)))) return true;
    if (identity.ids.size === 0 && identity.names.has(part.functionResponse.name)) return true;
  }
  return false;
}

function detailMessageClasses(message: MessageRecord): Record<string, boolean> {
  return {
    'is-selected-detail-message': isSelectedDetailMessage(message),
    'is-related-tool-output': isRelatedToolOutputMessage(message)
  };
}

function visibleMessageText(message: MessageRecord): string {
  return message.content.parts
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function messagePreview(message: MessageRecord): string {
  const text = visibleMessageText(message);
  if (text) return text;
  return message.content.parts.some((part) => 'functionCall' in part)
    ? '工具调用消息'
    : message.content.parts.some((part) => 'functionResponse' in part)
      ? '工具响应消息'
      : '空消息';
}

function toolParts(message: MessageRecord): ContentPart[] {
  return message.content.parts.filter((part) => isFunctionCallPart(part) || isFunctionResponsePart(part));
}

function toolCallForPart(message: MessageRecord, part: ContentPart): ToolCallRecord | undefined {
  const state = activeState.value;
  if (!state) return undefined;

  if (isFunctionResponsePart(part)) return toolCallForResponsePart(message, part);

  const id = isFunctionCallPart(part) ? part.id : undefined;
  const name = isFunctionCallPart(part) ? part.functionCall.name : undefined;
  const sameMessage = state.toolCalls.filter((call) => call.messageId === message.id);
  return sameMessage.find((call) => matchesToolCallPart(call, id, name))
    ?? (id ? state.toolCalls.find((call) => toolCallIdMatches(call, id)) : undefined);
}

function toolCallForResponsePart(message: MessageRecord, part: Extract<ContentPart, { functionResponse: unknown }>): ToolCallRecord | undefined {
  const state = activeState.value;
  if (!state) return undefined;

  const id = part.id;
  const name = part.functionResponse.name;
  const candidates = runScopedToolCalls(message, name);
  if (id) {
    const byId = candidates.find((call) => toolCallIdMatches(call, id))
      ?? state.toolCalls.find((call) => toolCallIdMatches(call, id));
    if (byId) return byId;
  }

  const responseFingerprint = jsonFingerprint(part.functionResponse.response);
  const byResult = candidates.find((call) => jsonFingerprint(call.result) === responseFingerprint);
  if (byResult) return byResult;

  return candidates.length === 1 ? candidates[0] : undefined;
}

function runScopedToolCalls(message: MessageRecord, toolName: string): ToolCallRecord[] {
  const state = activeState.value;
  if (!state) return [];

  const runIds = new Set(state.messageRunLinks.filter((link) => link.messageId === message.id).map((link) => link.runId));
  const toolCallIds = new Set(state.toolCallRunLinks.filter((link) => runIds.has(link.runId)).map((link) => link.toolCallId));
  return state.toolCalls.filter((call) => toolCallIds.has(call.id) && call.name === toolName);
}

function matchesToolCallPart(call: ToolCallRecord, partId: string | undefined, toolName: string | undefined): boolean {
  if (partId && toolCallIdMatches(call, partId)) return true;
  return !!toolName && call.name === toolName;
}

function toolCallIdMatches(call: ToolCallRecord, id: string): boolean {
  return call.id === id || call.functionCallId === id;
}

function toolPartKind(part: ContentPart): string {
  if (isFunctionCallPart(part)) return '工具调用';
  if (isFunctionResponsePart(part)) return '工具响应';
  return '工具消息';
}

function toolNameForPart(part: ContentPart): string {
  if (isFunctionCallPart(part)) return part.functionCall.name;
  if (isFunctionResponsePart(part)) return part.functionResponse.name;
  return 'unknown';
}

function toolInputJson(part: ContentPart): string {
  if (isFunctionCallPart(part)) return stringifyJson(part.functionCall.args);
  return '';
}

function toolOutputJson(part: ContentPart): string {
  if (isFunctionResponsePart(part)) return stringifyJson(part.functionResponse.response);
  return '';
}

function toolExecutionInfo(call: ToolCallRecord | undefined): string {
  if (!call) return '状态：未找到对应工具调用记录';
  const lines = [
    `状态：${toolStatusLabel(call.status)} (${call.status})`,
    ...toolCallIdLines(call),
    `创建时间：${formatTime(call.createdAt)}`,
    `更新时间：${formatTime(call.updatedAt)}`,
    call.error ? `错误：${call.error}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

function toolResponseExecutionInfo(call: ToolCallRecord | undefined): string {
  if (!call) return '状态：未找到对应工具调用记录';
  const lines = [
    `状态：${toolStatusLabel(call.status)} (${call.status})`,
    ...toolCallIdLines(call),
    call.durationMs !== undefined ? `耗时：${formatDuration(call.durationMs)}` : undefined,
    `创建时间：${formatTime(call.createdAt)}`,
    `更新时间：${formatTime(call.updatedAt)}`,
    call.error ? `错误：${call.error}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

function toolInfoForPart(part: ContentPart, call: ToolCallRecord | undefined): string {
  return isFunctionResponsePart(part) ? toolResponseExecutionInfo(call) : toolExecutionInfo(call);
}

function toolCallIdLines(call: ToolCallRecord): string[] {
  if (!call.functionCallId || call.functionCallId === call.id) return [`调用 ID：${call.id}`];
  return [`ToolCall ID：${call.id}`, `FunctionCall ID：${call.functionCallId}`];
}

function toolStatusLabel(status: ToolCallStatus): string {
  switch (status) {
    case 'streaming': return '生成中';
    case 'queued': return '排队中';
    case 'awaiting_approval': return '等待批准';
    case 'executing': return '执行中';
    case 'awaiting_change_apply': return '等待应用更改';
    case 'applying_change': return '应用更改中';
    case 'change_applied': return '更改已应用';
    case 'change_rejected': return '更改已拒绝';
    case 'awaiting_result_submit': return '等待结果回传';
    case 'success': return '成功';
    case 'warning': return '警告';
    case 'error': return '失败';
  }
}

function stringifyJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function jsonFingerprint(value: unknown): string {
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

function formatDuration(value: number): string {
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
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

function invocationStatusLabel(status: LlmInvocationRecord['status'] | undefined): string {
  switch (status) {
    case 'resolving': return '解析配置中';
    case 'ready': return '已准备';
    case 'streaming': return '生成中';
    case 'complete': return '已完成';
    case 'error': return '失败';
    case 'cancelled': return '已取消';
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
          <button type="button" class="run-detail-close" aria-label="关闭" title="关闭" @click="close">
            <IconX stroke="2" aria-hidden="true" />
          </button>
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

              <section v-if="selectedInvocation" class="run-detail-section">
                <h3>调用快照</h3>
                <dl class="run-detail-grid">
                  <div><dt>Invocation ID</dt><dd>{{ selectedInvocation.id }}</dd></div>
                  <div><dt>Request ID</dt><dd>{{ selectedInvocation.requestId }}</dd></div>
                  <div><dt>状态</dt><dd>{{ invocationStatusLabel(selectedInvocation.status) }} · {{ selectedInvocation.status }}</dd></div>
                  <div><dt>渠道配置</dt><dd>{{ selectedInvocationSettings?.providerConfigName ?? '—' }}</dd></div>
                  <div><dt>渠道 ID</dt><dd>{{ selectedInvocationSettings?.providerConfigId ?? '—' }}</dd></div>
                  <div><dt>Provider</dt><dd>{{ selectedInvocationSettings?.provider ?? '—' }}</dd></div>
                  <div><dt>Base URL</dt><dd>{{ selectedInvocationSettings?.baseUrl ?? '—' }}</dd></div>
                  <div><dt>Model ID</dt><dd>{{ selectedInvocationSettings?.modelId ?? '—' }}</dd></div>
                  <div><dt>Model Name</dt><dd>{{ selectedInvocationSettings?.modelName ?? selectedInvocationSettings?.displayModelName ?? '—' }}</dd></div>
                  <div><dt>显示名称</dt><dd>{{ selectedInvocationSettings?.displayModelName ?? '—' }}</dd></div>
                  <div><dt>Tool Call Format</dt><dd>{{ selectedInvocationSettings?.toolCallFormat ?? '—' }}</dd></div>
                  <div><dt>创建时间</dt><dd>{{ formatTime(selectedInvocation.createdAt) }}</dd></div>
                  <div><dt>解析时间</dt><dd>{{ formatTime(selectedInvocation.resolvedAt) }}</dd></div>
                  <div><dt>开始时间</dt><dd>{{ formatTime(selectedInvocation.startedAt) }}</dd></div>
                  <div><dt>完成时间</dt><dd>{{ formatTime(selectedInvocation.completedAt) }}</dd></div>
                  <div><dt>输出耗时</dt><dd>{{ selectedInvocation.streamOutputDurationMs !== undefined ? formatDuration(selectedInvocation.streamOutputDurationMs) : '—' }}</dd></div>
                </dl>
                <div v-if="invocationGenerationConfigJson" class="run-detail-tool-json-block">
                  <span>Generation Config</span>
                  <pre class="run-detail-json">{{ invocationGenerationConfigJson }}</pre>
                </div>
                <div v-if="invocationRequestBodyJson" class="run-detail-tool-json-block">
                  <span>Request Body 覆盖</span>
                  <pre class="run-detail-json">{{ invocationRequestBodyJson }}</pre>
                </div>
                <div v-if="invocationHeadersJson" class="run-detail-tool-json-block">
                  <span>Headers 快照（敏感值已隐藏）</span>
                  <pre class="run-detail-json">{{ invocationHeadersJson }}</pre>
                </div>
                <div v-if="invocationUsageJson" class="run-detail-tool-json-block">
                  <span>Usage Metadata</span>
                  <pre class="run-detail-json">{{ invocationUsageJson }}</pre>
                </div>
                <p v-if="selectedInvocation.error" class="run-detail-empty is-error">{{ selectedInvocation.error }}</p>
              </section>

              <section v-if="inputMessages.length" class="run-detail-section">
                <h3>输入消息</h3>
                <article
                  v-for="message in inputMessages"
                  :key="message.id"
                  class="run-detail-message"
                  :class="detailMessageClasses(message)"
                >
                  <span class="run-detail-message-meta">{{ message.role }} · #{{ message.seq }}</span>
                  <p v-if="visibleMessageText(message)">{{ visibleMessageText(message) }}</p>
                  <div v-if="toolParts(message).length" class="run-detail-tool-parts">
                    <section v-for="(part, index) in toolParts(message)" :key="`${message.id}-tool-${index}`" class="run-detail-tool-card">
                      <header class="run-detail-tool-card-head">
                        <span>{{ toolPartKind(part) }}</span>
                        <strong>{{ toolNameForPart(part) }}</strong>
                      </header>
                      <pre class="run-detail-tool-info">{{ toolInfoForPart(part, toolCallForPart(message, part)) }}</pre>
                      <div v-if="toolInputJson(part)" class="run-detail-tool-json-block">
                        <span>输入 JSON</span>
                        <pre class="run-detail-json">{{ toolInputJson(part) }}</pre>
                      </div>
                      <div v-if="toolOutputJson(part)" class="run-detail-tool-json-block">
                        <span>输出 JSON</span>
                        <pre class="run-detail-json">{{ toolOutputJson(part) }}</pre>
                      </div>
                    </section>
                  </div>
                  <p v-else-if="!visibleMessageText(message)">{{ messagePreview(message) }}</p>
                </article>
              </section>

              <section v-if="outputMessages.length" class="run-detail-section">
                <h3>输出消息</h3>
                <article
                  v-for="message in outputMessages"
                  :key="message.id"
                  class="run-detail-message"
                  :class="detailMessageClasses(message)"
                >
                  <span class="run-detail-message-meta">{{ message.role }} · #{{ message.seq }} · {{ message.status }}</span>
                  <p v-if="visibleMessageText(message)">{{ visibleMessageText(message) }}</p>
                  <div v-if="toolParts(message).length" class="run-detail-tool-parts">
                    <section v-for="(part, index) in toolParts(message)" :key="`${message.id}-tool-${index}`" class="run-detail-tool-card">
                      <header class="run-detail-tool-card-head">
                        <span>{{ toolPartKind(part) }}</span>
                        <strong>{{ toolNameForPart(part) }}</strong>
                      </header>
                      <pre class="run-detail-tool-info">{{ toolInfoForPart(part, toolCallForPart(message, part)) }}</pre>
                      <div v-if="toolInputJson(part)" class="run-detail-tool-json-block">
                        <span>输入 JSON</span>
                        <pre class="run-detail-json">{{ toolInputJson(part) }}</pre>
                      </div>
                      <div v-if="toolOutputJson(part)" class="run-detail-tool-json-block">
                        <span>输出 JSON</span>
                        <pre class="run-detail-json">{{ toolOutputJson(part) }}</pre>
                      </div>
                    </section>
                  </div>
                  <p v-else-if="!visibleMessageText(message)">{{ messagePreview(message) }}</p>
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
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  line-height: 1;
  cursor: pointer;
}

.run-detail-close :deep(svg) {
  width: 16px;
  height: 16px;
  display: block;
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
  position: relative;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.run-detail-message.is-selected-detail-message {
  border-color: color-mix(in srgb, var(--vscode-foreground) 40%, var(--vscode-panel-border) 60%);
  box-shadow: inset 4px 0 0 var(--vscode-foreground);
  padding-left: calc(var(--space-2) + 4px);
}

.run-detail-message.is-related-tool-output {
  border-color: color-mix(in srgb, var(--vscode-descriptionForeground) 36%, var(--vscode-panel-border) 64%);
  box-shadow: inset 4px 0 0 color-mix(in srgb, var(--vscode-descriptionForeground) 72%, transparent);
  padding-left: calc(var(--space-2) + 4px);
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

.run-detail-tool-parts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.run-detail-tool-card {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}

.run-detail-tool-card-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.run-detail-tool-card-head span {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.run-detail-tool-card-head strong {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, monospace);
}

.run-detail-tool-info {
  margin: 0 0 var(--space-2);
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--font-size-xs);
}

.run-detail-tool-json-block + .run-detail-tool-json-block {
  margin-top: var(--space-2);
}

.run-detail-tool-json-block > span {
  display: block;
  margin-bottom: 4px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
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
