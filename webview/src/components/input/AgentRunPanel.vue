<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconMessage2, IconRobot, IconX } from '@tabler/icons-vue';
import type {
  AgentAnswerRecord,
  AgentRunRecord,
  AgentRunSourceLinkRecord,
  AgentRunStatus,
  AgentRunTargetLinkRecord,
  ToolCallRecord,
  ToolCallRunLinkRecord,
  ToolCallStatus
} from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import { bridge, BridgeMessageType } from '@webview/transport';

interface RunAgentPayloadLike {
  runId?: string;
  childRunId?: string;
  agentId?: string;
  agentType?: string;
  conversationId?: string;
  answerBridgeId?: string;
  status?: string;
}

interface RunAgentArgsLike {
  prompt?: string;
  foregroundWaitMs?: number;
  agent?: {
    id?: string;
    type?: string;
  };
}

interface AgentPanelEntry {
  toolCallId: string;
  runId?: string;
  agentId?: string;
  conversationId?: string;
  answerBridgeId?: string;
  answer?: AgentAnswerRecord;
  prompt: string;
  targetLabel: string;
  status: AgentRunStatus | ToolCallStatus | string;
  statusLabel: string;
  statusTone: 'running' | 'done' | 'warning' | 'error';
  toolCalls: ToolCallRecord[];
  startedAt: number;
  updatedAt: number;
}

interface AgentRunTooltipRow {
  kind?: 'row';
  label: string;
  value: string;
  nested?: boolean;
}

interface AgentRunTooltipDivider {
  kind: 'divider';
  id: string;
}

type AgentRunTooltipItem = AgentRunTooltipRow | AgentRunTooltipDivider;

const RUN_AGENT_TOOL_NAME = 'run_agent';
const DEFAULT_RUN_AGENT_TYPE = 'worker';
const TERMINAL_RUN_STATUSES = new Set<AgentRunStatus>(['completed', 'failed', 'cancelled', 'stale']);
const TERMINAL_TOOL_STATUSES = new Set<ToolCallStatus>(['success', 'warning', 'error']);
const MAX_TOOLTIP_TOOL_CALLS = 2;

const clientState = useClientStateStore();
const conversationTimeline = useConversationTimelineStore();
const open = ref(false);
const selectedKey = ref<string | undefined>();
const rootRef = ref<HTMLElement | null>(null);
const listScroller = ref<HTMLElement | null>(null);
const detailScroller = ref<HTMLElement | null>(null);

const entries = computed<AgentPanelEntry[]>(() => buildEntries());
const runningCount = computed(() => entries.value.filter((entry) => entry.statusTone === 'running').length);
const selectedEntry = computed(() => entries.value.find((entry) => entryKey(entry) === selectedKey.value) ?? entries.value[0]);
const panelSummary = computed(() => {
  if (entries.value.length === 0) return '暂无后台 Agent';
  return runningCount.value > 0 ? `${runningCount.value} 个运行中 / ${entries.value.length} 个 AgentRun` : `${entries.value.length} 个 AgentRun`;
});
const detailRefreshKey = computed(() => `${entryKey(selectedEntry.value)}:${selectedEntry.value?.updatedAt ?? 0}`);

watch(entries, (nextEntries) => {
  if (nextEntries.length === 0) {
    selectedKey.value = undefined;
    return;
  }
  if (!selectedKey.value || !nextEntries.some((entry) => entryKey(entry) === selectedKey.value)) {
    selectedKey.value = entryKey(nextEntries[0]);
  }
}, { immediate: true });

watch(open, (isOpen) => {
  if (!isOpen) return;
  void nextTick(() => {
    listScroller.value?.scrollTo({ top: 0 });
    detailScroller.value?.scrollTo({ top: 0 });
  });
});

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

function toggleOpen(): void {
  open.value = !open.value;
}

function closePanel(): void {
  open.value = false;
}

function selectEntry(entry: AgentPanelEntry): void {
  selectedKey.value = entryKey(entry);
  void nextTick(() => detailScroller.value?.scrollTo({ top: 0 }));
}

function openConversationForEntry(entry: AgentPanelEntry | undefined): void {
  const conversationId = entry?.conversationId?.trim();
  if (!conversationId) return;
  const conversation = clientState.conversations.find((candidate) => candidate.id === conversationId);
  const title = conversation?.title?.trim();
  void bridge.request(BridgeMessageType.ConversationOpen, {
    conversationId,
    ...(title ? { title } : {})
  });
  closePanel();
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target;
  if (target instanceof Node && rootRef.value?.contains(target)) return;
  open.value = false;
}

function buildEntries(): AgentPanelEntry[] {
  const timelineState = conversationTimeline.currentTimeline.state;
  const calls = timelineState.toolCalls
    .filter((call) => call.name === RUN_AGENT_TOOL_NAME)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id));

  const runsById = recordMap<AgentRunRecord>([...clientState.agentRuns, ...timelineState.agentRuns]);
  const targetsByRunId = latestByRunId<AgentRunTargetLinkRecord>([...clientState.agentRunTargetLinks, ...timelineState.agentRunTargetLinks]);
  const sourceLinks = [...clientState.agentRunSourceLinks, ...timelineState.agentRunSourceLinks];
  const answersById = recordMap<AgentAnswerRecord>([...clientState.agentAnswers, ...timelineState.agentAnswers]);
  const toolCallsById = recordMap<ToolCallRecord>([...clientState.toolCalls, ...timelineState.toolCalls]);
  const callsByRunId = groupToolCallsByRunId(
    toolCallsById,
    [...clientState.toolCallRunLinks, ...timelineState.toolCallRunLinks]
  );

  const built = calls
    .map((call) => buildEntry(call, runsById, targetsByRunId, sourceLinks, answersById, callsByRunId))
    .filter((entry): entry is AgentPanelEntry => !!entry);
  return dedupeEntriesByKey(built)
    .sort((left, right) => statusPriority(left) - statusPriority(right) || right.updatedAt - left.updatedAt || right.startedAt - left.startedAt || entryKey(left).localeCompare(entryKey(right)));
}

function dedupeEntriesByKey(entries: AgentPanelEntry[]): AgentPanelEntry[] {
  const map = new Map<string, AgentPanelEntry>();
  for (const entry of entries) {
    const key = entryKey(entry);
    const current = map.get(key);
    if (!current || shouldReplaceEntry(current, entry)) map.set(key, entry);
  }
  return [...map.values()];
}

function shouldReplaceEntry(current: AgentPanelEntry, next: AgentPanelEntry): boolean {
  return statusPriority(next) < statusPriority(current)
    || (statusPriority(next) === statusPriority(current) && next.updatedAt > current.updatedAt)
    || (statusPriority(next) === statusPriority(current) && next.updatedAt === current.updatedAt && next.startedAt > current.startedAt);
}

function buildEntry(
  call: ToolCallRecord,
  runsById: Map<string, AgentRunRecord>,
  targetsByRunId: Map<string, AgentRunTargetLinkRecord>,
  sourceLinks: AgentRunSourceLinkRecord[],
  answersById: Map<string, AgentAnswerRecord>,
  toolCallsByRunId: Map<string, ToolCallRecord[]>
): AgentPanelEntry | undefined {
  const args = parseJson<RunAgentArgsLike>(call.args) ?? {};
  const toolData = readRunAgentPayload(call.result) ?? readRunAgentPayload(call.progress) ?? {};
  const source = sourceLinks
    .filter((link) => link.sourceToolCallId === call.id || (toolData.runId && link.runId === toolData.runId) || (toolData.childRunId && link.runId === toolData.childRunId))
    .sort((left, right) => right.id.localeCompare(left.id))[0];
  const initialRunId = toolData.runId || toolData.childRunId || source?.runId;
  const answerBridgeId = toolData.answerBridgeId || source?.answerBridgeId;
  const bridgedRunIds = answerBridgeId
    ? sourceLinks.filter((link) => link.answerBridgeId === answerBridgeId).map((link) => link.runId)
    : [];
  const run = selectDisplayRun([initialRunId, ...bridgedRunIds], runsById);
  const runId = run?.id ?? initialRunId;
  const target = runId ? targetsByRunId.get(runId) : undefined;
  const answer = answerBridgeId ? answersById.get(answerBridgeId) : undefined;
  const status = run?.status ?? call.status;
  const statusLabel = answer ? '已提交' : run ? runStatusLabel(run.status) : toolStatusLabel(call.status, toolData.status);
  const statusTone = run ? runStatusTone(run.status, !!answer) : toolStatusTone(call.status, !!answer);
  const agentId = toolData.agentId || target?.agentId;
  const conversationId = toolData.conversationId || target?.conversationId;
  const prompt = args.prompt?.trim() ?? '';
  const targetLabel = args.agent?.id?.trim()
    || args.agent?.type?.trim()
    || toolData.agentType
    || agentId
    || DEFAULT_RUN_AGENT_TYPE;
  const toolCalls = runId
    ? selectActiveToolCalls(run?.status, toolCallsByRunId.get(runId) ?? [])
    : [];

  return {
    toolCallId: call.id,
    ...(runId ? { runId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(answerBridgeId ? { answerBridgeId } : {}),
    ...(answer ? { answer } : {}),
    prompt,
    targetLabel,
    status,
    statusLabel,
    statusTone,
    toolCalls,
    startedAt: call.createdAt,
    updatedAt: Math.max(call.updatedAt, run?.updatedAt ?? 0, answer?.updatedAt ?? 0, ...toolCalls.map((toolCall) => toolCall.updatedAt))
  };
}

function readRunAgentPayload(value: unknown): RunAgentPayloadLike | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const output = asRecord(record.output);
  const candidate = output ?? record;
  return {
    runId: stringField(candidate, 'runId'),
    childRunId: stringField(candidate, 'childRunId'),
    agentId: stringField(candidate, 'agentId'),
    agentType: stringField(candidate, 'agentType'),
    conversationId: stringField(candidate, 'conversationId'),
    answerBridgeId: stringField(candidate, 'answerBridgeId'),
    status: stringField(candidate, 'status')
  };
}

function selectDisplayRun(runIds: Array<string | undefined>, runsById: Map<string, AgentRunRecord>): AgentRunRecord | undefined {
  const seen = new Set<string>();
  const runs = runIds
    .filter((id): id is string => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((id) => runsById.get(id))
    .filter((run): run is AgentRunRecord => !!run);
  if (runs.length === 0) return undefined;
  const active = runs
    .filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
    .sort(compareRunsByNewest)[0];
  return active ?? runs.sort(compareRunsByNewest)[0];
}

function compareRunsByNewest(left: AgentRunRecord, right: AgentRunRecord): number {
  return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id);
}

function recordMap<T extends { id: string }>(records: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const record of records) map.set(record.id, record);
  return map;
}

function groupToolCallsByRunId(
  toolCallsById: Map<string, ToolCallRecord>,
  links: ToolCallRunLinkRecord[]
): Map<string, ToolCallRecord[]> {
  const groupedIds = new Map<string, Set<string>>();
  for (const link of links) {
    const ids = groupedIds.get(link.runId) ?? new Set<string>();
    ids.add(link.toolCallId);
    groupedIds.set(link.runId, ids);
  }

  const grouped = new Map<string, ToolCallRecord[]>();
  for (const [runId, ids] of groupedIds) {
    const calls = [...ids]
      .map((id) => toolCallsById.get(id))
      .filter((call): call is ToolCallRecord => !!call);
    grouped.set(runId, calls);
  }
  return grouped;
}

function selectActiveToolCalls(runStatus: AgentRunStatus | undefined, calls: ToolCallRecord[]): ToolCallRecord[] {
  const activeCalls = calls.filter((call) => !TERMINAL_TOOL_STATUSES.has(call.status));
  if (activeCalls.length > 0) return [...activeCalls].sort(compareToolCallsByExecutionOrder);
  if (runStatus !== 'waiting_tool') return [];
  return [...calls].sort(compareToolCallsByLatest).slice(0, 1);
}

function compareToolCallsByExecutionOrder(left: ToolCallRecord, right: ToolCallRecord): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function compareToolCallsByLatest(left: ToolCallRecord, right: ToolCallRecord): number {
  return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id);
}

function latestByRunId<T extends { runId: string; id: string }>(records: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const record of records) {
    const current = map.get(record.runId);
    if (!current || record.id.localeCompare(current.id) > 0) map.set(record.runId, record);
  }
  return map;
}

function parseJson<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function entryKey(entry: AgentPanelEntry | undefined): string {
  if (!entry) return 'none';
  return entry.answerBridgeId || entry.runId || entry.toolCallId;
}

function statusPriority(entry: AgentPanelEntry): number {
  if (entry.statusTone === 'running') return 0;
  if (entry.answer) return 1;
  return 2;
}

function runStatusLabel(status: AgentRunStatus): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'preparing': return '准备中';
    case 'running': return '运行中';
    case 'waiting_tool': return '等待工具';
    case 'waiting_child_run': return '等待子任务';
    case 'delivering': return '投递结果';
    case 'paused': return '已暂停';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'cancelled': return '已终止';
    case 'stale': return '已过期';
  }
}

function runStatusTone(status: AgentRunStatus, hasAnswer: boolean): AgentPanelEntry['statusTone'] {
  if (hasAnswer || status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled' || status === 'stale') return 'error';
  if (status === 'paused') return 'warning';
  return TERMINAL_RUN_STATUSES.has(status) ? 'done' : 'running';
}

function toolStatusLabel(status: ToolCallStatus, payloadStatus: string | undefined): string {
  if (payloadStatus === 'backgrounded') return '后台运行';
  switch (status) {
    case 'streaming': return '生成中';
    case 'queued': return '待执行';
    case 'awaiting_approval': return '待批准';
    case 'awaiting_user_input': return '待用户回答';
    case 'executing': return '启动中';
    case 'awaiting_change_apply': return '待应用';
    case 'applying_change': return '应用中';
    case 'change_applied': return '已应用';
    case 'change_rejected': return '已拒绝';
    case 'awaiting_result_submit': return '待提交结果';
    case 'success': return '已返回';
    case 'warning': return '警告';
    case 'error': return '失败';
  }
}

function toolStatusTone(status: ToolCallStatus, hasAnswer: boolean): AgentPanelEntry['statusTone'] {
  if (hasAnswer) return 'done';
  if (status === 'error') return 'error';
  if (status === 'warning') return 'warning';
  return TERMINAL_TOOL_STATUSES.has(status) ? 'done' : 'running';
}

function entryTooltipTitle(entry: AgentPanelEntry): string {
  return `${entry.targetLabel} · 运行详情`;
}

function entryStatusAriaLabel(entry: AgentPanelEntry): string {
  const toolNames = [...new Set(entry.toolCalls.map((call) => call.name))];
  const toolDetail = toolNames.length > 0 ? `，当前工具：${toolNames.join('、')}` : '';
  return `${entry.targetLabel}，${entry.statusLabel}${toolDetail}`;
}

function entryStatusTooltipRows(entry: AgentPanelEntry): AgentRunTooltipItem[] {
  const rows: AgentRunTooltipItem[] = [
    { label: '当前阶段', value: entry.statusLabel },
    { label: '任务', value: previewText(entry.prompt, 72) }
  ];
  if (entry.toolCalls.length > 0) {
    rows.push({ kind: 'divider', id: 'tools' });
    for (const [index, call] of entry.toolCalls.slice(0, MAX_TOOLTIP_TOOL_CALLS).entries()) {
      const toolLabel = entry.toolCalls.length > 1 ? `工具 ${index + 1}` : '工具';
      rows.push({ label: toolLabel, value: call.name });
      const content = toolCallContentPreview(call);
      if (content) rows.push({ label: '内容', value: content, nested: true });
      rows.push({ label: '进度', value: toolCallDetailStatusLabel(call.status), nested: true });
    }
    if (entry.toolCalls.length > MAX_TOOLTIP_TOOL_CALLS) {
      const otherNames = entry.toolCalls.slice(MAX_TOOLTIP_TOOL_CALLS).map((call) => call.name).join('、');
      rows.push({ label: '其他工具', value: compactTooltipValue(otherNames, 72) });
    }
  } else if (entry.status === 'waiting_tool') {
    rows.push(
      { kind: 'divider', id: 'tools-pending' },
      { label: '等待对象', value: '工具信息同步中' }
    );
  } else if (entry.status === 'waiting_child_run') {
    rows.push(
      { kind: 'divider', id: 'child-run' },
      { label: '等待对象', value: '子任务' }
    );
  }
  return rows;
}

function toolCallContentPreview(call: ToolCallRecord): string | undefined {
  const value = call.summary?.trim() || call.args.trim();
  if (!value || value === '{}') return undefined;
  return compactTooltipValue(value, 72);
}

function compactTooltipValue(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function toolCallDetailStatusLabel(status: ToolCallStatus): string {
  switch (status) {
    case 'streaming': return '正在生成';
    case 'queued': return '等待调度';
    case 'awaiting_approval': return '等待批准';
    case 'awaiting_user_input': return '等待用户回答';
    case 'executing': return '执行中';
    case 'awaiting_change_apply': return '等待应用更改';
    case 'applying_change': return '应用更改中';
    case 'change_applied': return '更改已应用';
    case 'change_rejected': return '更改已拒绝';
    case 'awaiting_result_submit': return '等待结果回传';
    case 'success': return '已完成';
    case 'warning': return '已完成（有警告）';
    case 'error': return '失败';
  }
}

function formatTime(value: number): string {
  if (!value) return '-';
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function previewText(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '(无 prompt 预览)';
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function answerPreview(answer: AgentAnswerRecord | undefined): string {
  if (!answer) return '尚未提交 answer。';
  const title = answer.title.trim();
  return title ? title : previewText(answer.content, 80);
}

function readAnswerPayload(entry: AgentPanelEntry): string {
  if (entry.answer) {
    return JSON.stringify({
      ok: true,
      answerBridgeId: entry.answerBridgeId,
      title: entry.answer.title,
      content: entry.answer.content
    }, null, 2);
  }
  if (!entry.answerBridgeId) {
    return JSON.stringify({ ok: false, status: 'not_found', error: 'answerBridgeId missing' }, null, 2);
  }
  // 区分“子对话还在运行、尚未提交”和“已中断可续”，避免误读成失败。
  const running = !TERMINAL_RUN_STATUSES.has(entry.status as AgentRunStatus) && !TERMINAL_TOOL_STATUSES.has(entry.status as ToolCallStatus);
  return JSON.stringify({
    ok: false,
    answerBridgeId: entry.answerBridgeId,
    status: running ? 'running' : 'interrupted',
    ...(running ? {} : entry.agentId ? { agentId: entry.agentId } : {}),
    error: running
      ? '对应 answerBridgeId 绑定的子对话仍在运行，尚未提交内容。请稍后重试或等待 submit_agent_answer 通知。'
      : entry.answerBridgeId
        ? `对应的子对话已中断。可调用 run_agent({ answerBridgeId: "${entry.answerBridgeId}", prompt, foregroundWaitMs }) 继续/追加同一子对话。`
        : '对应的子对话已中断。可向同一个 Agent 追加消息以触发继续。'
  }, null, 2);
}
</script>

<template>
  <div ref="rootRef" class="agent-run-root">
    <button
      type="button"
      class="agent-run-trigger"
      :class="{ 'is-active': open, 'has-running': runningCount > 0 }"
      aria-label="Agent 面板"
      :aria-expanded="open"
      @click.stop="toggleOpen"
    >
      <IconRobot class="agent-run-trigger-icon" stroke="2" aria-hidden="true" />
      <span v-if="entries.length" class="agent-run-count">{{ entries.length }}</span>
    </button>

    <section v-if="open" class="agent-run-panel" role="dialog" aria-label="Agent 面板">
      <header class="agent-run-header">
        <div class="agent-run-title">
          <span>Agent 面板</span>
          <span>{{ panelSummary }}</span>
        </div>
        <button type="button" class="agent-run-close" aria-label="关闭 Agent 面板" @click="closePanel">
          <IconX stroke="2" aria-hidden="true" />
        </button>
      </header>

      <div v-if="entries.length" class="agent-run-body">
        <div class="agent-run-list-shell">
          <div ref="listScroller" class="agent-run-list">
            <button
              v-for="entry in entries"
              :key="entryKey(entry)"
              type="button"
              class="agent-run-item"
              :class="{ 'is-selected': entryKey(selectedEntry) === entryKey(entry) }"
              @click="selectEntry(entry)"
            >
              <span class="agent-run-item-top">
                <span class="agent-run-status" :class="`is-${entry.statusTone}`">{{ entry.statusLabel }}</span>
                <span class="agent-run-target">{{ entry.targetLabel }}</span>
              </span>
              <span class="agent-run-preview">{{ previewText(entry.prompt) }}</span>
              <span class="agent-run-subline">{{ formatTime(entry.startedAt) }} · {{ entry.runId || entry.toolCallId }}</span>
              <span v-if="entry.answerBridgeId" class="agent-run-answer-line">answer: {{ entry.answerBridgeId }}</span>
            </button>
          </div>
          <AdvancedScrollbar :scroller="listScroller" :refresh-key="entries.length" variant="minimal" />
        </div>

        <article v-if="selectedEntry" class="agent-run-detail">
          <header class="agent-run-detail-header">
            <span class="agent-run-detail-main">
              <HoverTooltipPanel
                class="agent-run-status"
                :class="`is-${selectedEntry.statusTone}`"
                :aria-label="entryStatusAriaLabel(selectedEntry)"
                :panel-title="entryTooltipTitle(selectedEntry)"
                :rows="entryStatusTooltipRows(selectedEntry)"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                tabindex="0"
              >
                <span>{{ selectedEntry.statusLabel }}</span>
              </HoverTooltipPanel>
              <span class="agent-run-detail-id">{{ selectedEntry.runId || selectedEntry.toolCallId }}</span>
            </span>
            <button
              v-if="selectedEntry.conversationId"
              type="button"
              class="agent-run-open-conversation"
              :aria-label="`打开对话 ${selectedEntry.conversationId}`"
              @click="openConversationForEntry(selectedEntry)"
            >
              <IconMessage2 stroke="2" aria-hidden="true" />
              <span>打开对话</span>
            </button>
          </header>
          <div class="agent-run-detail-scroll-shell">
            <div ref="detailScroller" class="agent-run-detail-scroll">
              <section class="agent-run-detail-section">
                <h3>运行信息</h3>
                <dl class="agent-run-param-grid">
                  <dt>Agent ID</dt><dd>{{ selectedEntry.agentId || '-' }}</dd>
                  <dt>Conversation ID</dt><dd>{{ selectedEntry.conversationId || '-' }}</dd>
                  <dt>Run ID</dt><dd>{{ selectedEntry.runId || '-' }}</dd>
                  <dt>Tool Call ID</dt><dd>{{ selectedEntry.toolCallId }}</dd>
                  <dt>Answer ID</dt><dd>{{ selectedEntry.answerBridgeId || '-' }}</dd>
                  <dt>开始</dt><dd>{{ formatTime(selectedEntry.startedAt) }}</dd>
                  <dt>更新</dt><dd>{{ formatTime(selectedEntry.updatedAt) }}</dd>
                </dl>
              </section>

              <section class="agent-run-detail-section">
                <h3>任务</h3>
                <pre>{{ selectedEntry.prompt || '(无 prompt)' }}</pre>
              </section>

              <section class="agent-run-detail-section">
                <h3>Answer</h3>
                <p class="agent-run-answer-summary">{{ answerPreview(selectedEntry.answer) }}</p>
                <pre>{{ readAnswerPayload(selectedEntry) }}</pre>
              </section>
            </div>
            <AdvancedScrollbar :scroller="detailScroller" :refresh-key="detailRefreshKey" variant="minimal" />
          </div>
        </article>
      </div>

      <div v-else class="agent-run-empty">暂无后台 Agent。</div>
    </section>
  </div>
</template>

<style scoped>
.agent-run-root {
  position: relative;
  flex: 0 0 auto;
}

.agent-run-trigger {
  position: relative;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.agent-run-trigger:hover,
.agent-run-trigger:focus-visible,
.agent-run-trigger.is-active {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.agent-run-trigger.has-running .agent-run-trigger-icon {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.agent-run-trigger-icon {
  width: 16px;
  height: 16px;
}

.agent-run-count {
  position: absolute;
  right: -2px;
  bottom: -2px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border: 1px solid var(--vscode-editor-background);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 68%, var(--vscode-editor-background) 32%);
  font-size: 9px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.agent-run-panel {
  position: absolute;
  right: calc(100% + 8px);
  bottom: 0;
  z-index: 40;
  width: min(760px, calc(100vw - 58px));
  height: min(430px, calc(100vh - 120px));
  min-height: 260px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.34);
  overflow: hidden;
}

.agent-run-header {
  min-height: 38px;
  padding: 7px 8px 7px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.agent-run-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: var(--font-size-sm);
  line-height: 1.25;
}

.agent-run-title span:first-child {
  font-weight: 600;
}

.agent-run-title span:last-child {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.agent-run-close {
  width: 24px;
  height: 24px;
  min-width: 24px;
  min-height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.agent-run-close:hover,
.agent-run-close:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.agent-run-close :deep(svg) {
  width: 16px;
  height: 16px;
}

.agent-run-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(190px, 0.42fr) minmax(260px, 0.58fr);
}

.agent-run-list-shell,
.agent-run-detail-scroll-shell {
  position: relative;
  min-height: 0;
}

.agent-run-list {
  height: 100%;
  min-height: 0;
  padding: 6px;
  border-right: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  scrollbar-width: none;
}

.agent-run-list::-webkit-scrollbar,
.agent-run-detail-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.agent-run-item {
  width: 100%;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  text-align: left;
}

.agent-run-item:hover,
.agent-run-item:focus-visible,
.agent-run-item.is-selected {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.agent-run-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.agent-run-status {
  flex: 0 0 auto;
  min-width: 48px;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
  line-height: 1.35;
  text-align: center;
}

.agent-run-status.is-running {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.agent-run-status.is-done {
  color: var(--vscode-testing-iconPassed, #73c991);
}

.agent-run-status.is-warning {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.agent-run-status.is-error {
  color: var(--vscode-errorForeground, #f48771);
}

.agent-run-status:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 1px;
}

.agent-run-target,
.agent-run-preview,
.agent-run-subline,
.agent-run-answer-line {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-run-target {
  color: var(--vscode-foreground);
  font-weight: 500;
}

.agent-run-preview {
  font-size: var(--font-size-sm);
}

.agent-run-subline,
.agent-run-answer-line {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.agent-run-detail {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.agent-run-detail-header {
  min-height: 36px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.agent-run-detail-main {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.agent-run-detail-id {
  min-width: 0;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-xs);
  font-family: var(--font-family-mono);
}

.agent-run-open-conversation {
  flex: 0 0 auto;
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-xs);
  line-height: 1.2;
}

.agent-run-open-conversation:hover,
.agent-run-open-conversation:focus-visible {
  color: var(--vscode-foreground);
  border-color: color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.agent-run-open-conversation :deep(svg) {
  width: 14px;
  height: 14px;
}

.agent-run-detail-scroll-shell {
  flex: 1;
}

.agent-run-detail-scroll {
  height: 100%;
  padding: 10px;
  overflow-y: auto;
  scrollbar-width: none;
}

.agent-run-detail-section {
  margin-bottom: 12px;
}

.agent-run-detail-section h3 {
  margin: 0 0 6px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.agent-run-detail-section pre {
  margin: 0;
  max-height: 168px;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.agent-run-param-grid {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 10px;
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.agent-run-param-grid dt {
  color: var(--vscode-descriptionForeground);
}

.agent-run-param-grid dd {
  min-width: 0;
  margin: 0;
  color: var(--vscode-foreground);
  overflow-wrap: anywhere;
  font-family: var(--font-family-mono);
}

.agent-run-answer-summary {
  margin: 0 0 6px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.agent-run-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}
</style>
