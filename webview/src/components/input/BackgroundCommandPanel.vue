<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconTerminal2, IconX } from '@tabler/icons-vue';
import { BridgeMessageType, type BackgroundCommandOutputResultPayload, type ToolCallEventRecord, type ToolCallRecord } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { bridge } from '@webview/transport';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import {
  parseShellCallArgs,
  parseShellResultOutput,
  shellProgressText,
  shellStreamText,
  type ShellArgs,
  type ShellResultOutput
} from '@webview/components/content/toolDisplay/shellToolModel';

interface CommandEntry {
  processId: string;
  shell: string;
  command: string;
  cwd?: string;
  timeout?: number;
  mode?: string;
  accessLabel: string;
  status: string;
  statusLabel: string;
  statusTone: 'running' | 'done' | 'warning' | 'error';
  stdout: string;
  stderr: string;
  progress: string;
  droppedChars?: number;
  exitCode?: number;
  killed?: boolean;
  running?: boolean;
  callCount: number;
  startedAt: number;
  updatedAt: number;
}

interface CommandDraft {
  processId: string;
  shell: string;
  command: string;
  cwd?: string;
  timeout?: number;
  mode?: string;
  accessLabel: string;
  status: string;
  stdout: string;
  stderr: string;
  progress: string;
  droppedChars?: number;
  exitCode?: number;
  killed?: boolean;
  running?: boolean;
  callCount: number;
  startedAt: number;
  updatedAt: number;
  latestOutputAt: number;
}

const clientState = useClientStateStore();
const conversationTimeline = useConversationTimelineStore();
const open = ref(false);
const selectedProcessId = ref<string | undefined>();
const rootRef = ref<HTMLElement | null>(null);
const listScroller = ref<HTMLElement | null>(null);
const detailScroller = ref<HTMLElement | null>(null);
const runtimeOutputs = ref<Record<string, BackgroundCommandOutputResultPayload>>({});
const viewedTerminalOutputs = ref<Record<string, true>>({});
const pendingOutputRequests = new Set<string>();
let pollTimer: number | undefined;
let stopOutputListener: (() => void) | undefined;

const entries = computed<CommandEntry[]>(() => buildCommandEntries());
const runningCount = computed(() => entries.value.filter((entry) => entry.statusTone === 'running').length);
const selectedEntry = computed(() => entries.value.find((entry) => entry.processId === selectedProcessId.value) ?? entries.value[0]);
const panelSummary = computed(() => {
  if (entries.value.length === 0) return '暂无后台命令';
  return runningCount.value > 0 ? `${runningCount.value} 个运行中 / ${entries.value.length} 个后台命令` : `${entries.value.length} 个后台命令`;
});
const detailRefreshKey = computed(() => `${selectedEntry.value?.processId ?? 'none'}:${selectedEntry.value?.updatedAt ?? 0}`);

watch(entries, (nextEntries) => {
  if (nextEntries.length === 0) {
    selectedProcessId.value = undefined;
    return;
  }
  if (!selectedProcessId.value || !nextEntries.some((entry) => entry.processId === selectedProcessId.value)) {
    selectedProcessId.value = nextEntries[0]?.processId;
  }
}, { immediate: true });

watch(open, (isOpen) => {
  if (!isOpen) {
    stopPolling();
    if (selectedProcessId.value && viewedTerminalOutputs.value[selectedProcessId.value]) selectedProcessId.value = undefined;
    return;
  }
  refreshRunningOutputs();
  startPolling();
  void nextTick(() => {
    listScroller.value?.scrollTo({ top: 0 });
    detailScroller.value?.scrollTo({ top: 0 });
  });
});

watch(() => entries.value.map((entry) => `${entry.processId}:${entry.statusTone}`).join('|'), () => {
  if (!open.value) return;
  refreshRunningOutputs();
});

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  stopOutputListener = bridge.on(BridgeMessageType.BackgroundCommandOutputResult, (message) => {
    const payload = message.payload;
    if (!payload) return;
    runtimeOutputs.value = { ...runtimeOutputs.value, [payload.processId]: payload };
    pendingOutputRequests.delete(payload.processId + ':peek');
    pendingOutputRequests.delete(payload.processId + ':consume');
    if (payload.consumed === true) {
      viewedTerminalOutputs.value = { ...viewedTerminalOutputs.value, [payload.processId]: true };
    }
  });
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  stopOutputListener?.();
  stopPolling();
});

function toggleOpen(): void {
  open.value = !open.value;
}

function closePanel(): void {
  open.value = false;
}

function selectEntry(entry: CommandEntry): void {
  selectedProcessId.value = entry.processId;
  requestOutput(entry.processId, true);
  void nextTick(() => detailScroller.value?.scrollTo({ top: 0 }));
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target;
  if (target instanceof Node && rootRef.value?.contains(target)) return;
  open.value = false;
}

function buildCommandEntries(): CommandEntry[] {
  const toolCalls = conversationTimeline.currentTimeline.state.toolCalls
    .filter((call) => isCommandTool(call.name))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const eventsByCallId = new Map<string, ToolCallEventRecord[]>();
  for (const event of clientState.toolCallEvents) {
    const events = eventsByCallId.get(event.toolCallId) ?? [];
    events.push(event);
    eventsByCallId.set(event.toolCallId, events);
  }

  const drafts = new Map<string, CommandDraft>();
  for (const call of toolCalls) {
    const args = parseShellCallArgs(call.args);
    const output = parseShellResultOutput(call.result);
    const processId = (output?.processId ?? args.processId)?.trim();
    if (!processId) continue;

    const events = (eventsByCallId.get(call.id) ?? []).sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
    const draft = drafts.get(processId) ?? createDraft(processId, call, args, output);
    mergeCall(draft, call, args, output, events);
    drafts.set(processId, draft);
  }

  return [...drafts.values()]
    .map((draft) => applyRuntimeOutput(draft, runtimeOutputs.value[draft.processId]))
    .map((draft) => ({
      ...draft,
      statusLabel: statusLabel(draft.status, draft.running, draft.exitCode, draft.killed),
      statusTone: statusTone(draft.status, draft.running, draft.exitCode)
    }))
    .filter((entry) => entry.killed !== true && !(viewedTerminalOutputs.value[entry.processId] && selectedProcessId.value !== entry.processId))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.startedAt - left.startedAt || left.processId.localeCompare(right.processId));
}

function createDraft(processId: string, call: ToolCallRecord, args: ShellArgs, output: ShellResultOutput | undefined): CommandDraft {
  return {
    processId,
    shell: call.name,
    command: args.command?.trim() || output?.command?.trim() || '',
    cwd: args.cwd?.trim() || undefined,
    timeout: args.timeout,
    mode: normalizeMode(args.mode),
    accessLabel: readonlyLabel(args),
    status: output?.status ?? call.status,
    stdout: '',
    stderr: '',
    progress: '',
    droppedChars: output?.droppedChars,
    exitCode: output?.exitCode,
    killed: output?.killed,
    running: output?.running,
    callCount: 0,
    startedAt: call.createdAt,
    updatedAt: call.updatedAt,
    latestOutputAt: 0
  };
}

function mergeCall(draft: CommandDraft, call: ToolCallRecord, args: ShellArgs, output: ShellResultOutput | undefined, events: ToolCallEventRecord[]): void {
  draft.callCount += 1;
  draft.startedAt = Math.min(draft.startedAt, call.createdAt);
  draft.updatedAt = Math.max(draft.updatedAt, call.updatedAt);
  if (!draft.command) draft.command = args.command?.trim() || output?.command?.trim() || '';
  if (!draft.cwd && args.cwd?.trim()) draft.cwd = args.cwd.trim();
  if (draft.timeout === undefined && args.timeout !== undefined) draft.timeout = args.timeout;
  if (!draft.mode) draft.mode = normalizeMode(args.mode);
  if (args.readonly !== undefined) draft.accessLabel = readonlyLabel(args);

  const stdout = shellStreamText(events, 'stdout') || output?.stdout || '';
  const stderr = shellStreamText(events, 'stderr') || output?.stderr || '';
  const progress = shellProgressText(events, stringifyValue);
  const hasRuntimeSnapshot = output !== undefined || stdout.length > 0 || stderr.length > 0 || progress.length > 0;
  if (hasRuntimeSnapshot && call.updatedAt >= draft.latestOutputAt) {
    draft.latestOutputAt = call.updatedAt;
    draft.status = output?.status ?? call.status;
    draft.stdout = stdout;
    draft.stderr = stderr;
    draft.progress = progress;
    draft.droppedChars = output?.droppedChars;
    draft.exitCode = output?.exitCode;
    draft.killed = output?.killed;
    draft.running = output?.running;
  }
}

function applyRuntimeOutput(draft: CommandDraft, output: BackgroundCommandOutputResultPayload | undefined): CommandDraft {
  if (!output) return draft;
  return {
    ...draft,
    command: draft.command || output.command,
    status: output.status ?? draft.status,
    stdout: output.stdout,
    stderr: output.stderr,
    progress: draft.progress,
    droppedChars: output.droppedChars,
    exitCode: output.exitCode,
    killed: output.killed,
    running: output.running,
    updatedAt: draft.updatedAt,
    latestOutputAt: draft.latestOutputAt
  };
}

function refreshRunningOutputs(): void {
  for (const entry of entries.value) {
    if (entry.statusTone === 'running') requestOutput(entry.processId, entry.processId === selectedProcessId.value);
  }
}

function requestOutput(processId: string, consume = false): void {
  const pendingKey = processId + ':' + (consume ? 'consume' : 'peek');
  if (!processId || pendingOutputRequests.has(pendingKey)) return;
  pendingOutputRequests.add(pendingKey);
  bridge.request(BridgeMessageType.BackgroundCommandOutputGet, { processId, consume }, { channel: 'state' });
}

function startPolling(): void {
  stopPolling();
  pollTimer = window.setInterval(refreshRunningOutputs, 2000);
}

function stopPolling(): void {
  if (pollTimer === undefined) return;
  window.clearInterval(pollTimer);
  pollTimer = undefined;
}

function isCommandTool(toolName: string): boolean {
  return toolName === 'shell' || toolName === 'bash';
}

function normalizeMode(mode: string | undefined): string {
  const value = mode?.trim();
  return value || 'execute';
}

function readonlyLabel(args: ShellArgs): string {
  return args.readonly?.trim().toLowerCase() === 'true' ? '只读' : '读写';
}

function statusLabel(status: string, running: boolean | undefined, exitCode: number | undefined, killed: boolean | undefined): string {
  if (running === true) return '运行中';
  if (killed) return '已终止';
  if (exitCode !== undefined && exitCode !== 0) return '异常终止';
  switch (status) {
    case 'running': return '运行中';
    case 'exited': return '已退出';
    case 'killed': return '已终止';
    case 'not_found': return '未找到';
    case 'completed':
    case 'success': return '已完成';
    case 'error': return '失败';
    default: return status || '未知';
  }
}

function statusTone(status: string, running: boolean | undefined, exitCode: number | undefined): CommandEntry['statusTone'] {
  if (running === true || status === 'running') return 'running';
  if (exitCode !== undefined && exitCode !== 0) return 'error';
  if (status === 'killed' || status === 'not_found') return 'warning';
  if (status === 'error') return 'error';
  return 'done';
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '-';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function commandPreview(entry: CommandEntry): string {
  return middleEllipsis(entry.command || '(无命令文本)', 92);
}

function middleEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(8, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
</script>

<template>
  <div ref="rootRef" class="background-command-root">
    <button
      type="button"
      class="background-command-trigger"
      :class="{ 'is-active': open, 'has-running': runningCount > 0 }"
      aria-label="后台命令管理"
      :aria-expanded="open"
      @click.stop="toggleOpen"
    >
      <IconTerminal2 class="background-command-trigger-icon" stroke="2" aria-hidden="true" />
      <span v-if="entries.length" class="background-command-count">{{ entries.length }}</span>
    </button>

    <section v-if="open" class="background-command-panel" role="dialog" aria-label="后台命令管理面板">
      <header class="background-command-header">
        <div class="background-command-title">
          <span>后台命令</span>
          <span>{{ panelSummary }}</span>
        </div>
        <button type="button" class="background-command-close" aria-label="关闭后台命令面板" @click="closePanel">
          <IconX stroke="2" aria-hidden="true" />
        </button>
      </header>

      <div v-if="entries.length" class="background-command-body">
        <div class="background-command-list-shell">
          <div ref="listScroller" class="background-command-list">
            <button
              v-for="entry in entries"
              :key="entry.processId"
              type="button"
              class="background-command-item"
              :class="{ 'is-selected': selectedEntry?.processId === entry.processId }"
              @click="selectEntry(entry)"
            >
              <span class="background-command-item-top">
                <span class="command-status" :class="`is-${entry.statusTone}`">{{ entry.statusLabel }}</span>
                <span class="command-shell">{{ entry.shell }}</span>
              </span>
              <span class="command-preview">{{ commandPreview(entry) }}</span>
              <span class="command-subline">{{ entry.accessLabel }} · {{ formatTime(entry.startedAt) }} · {{ entry.processId }}</span>
            </button>
          </div>
          <AdvancedScrollbar :scroller="listScroller" :refresh-key="entries.length" variant="minimal" />
        </div>

        <article v-if="selectedEntry" class="background-command-detail">
          <header class="command-detail-header">
            <span class="command-status" :class="`is-${selectedEntry.statusTone}`">{{ selectedEntry.statusLabel }}</span>
            <span class="command-detail-id">{{ selectedEntry.processId }}</span>
          </header>
          <div class="command-detail-scroll-shell">
            <div ref="detailScroller" class="command-detail-scroll">
              <section class="command-detail-section">
                <h3>输入命令</h3>
                <pre>{{ selectedEntry.command || '(无命令文本)' }}</pre>
              </section>

              <section class="command-detail-section">
                <h3>输出日志</h3>
                <pre v-if="selectedEntry.stdout" class="command-log is-stdout">{{ selectedEntry.stdout }}</pre>
                <pre v-if="selectedEntry.stderr" class="command-log is-stderr">{{ selectedEntry.stderr }}</pre>
                <pre v-if="selectedEntry.progress" class="command-log is-progress">{{ selectedEntry.progress }}</pre>
                <p v-if="!selectedEntry.stdout && !selectedEntry.stderr && !selectedEntry.progress" class="command-empty-text">暂无已同步输出。</p>
              </section>

              <section class="command-detail-section">
                <h3>参数</h3>
                <dl class="command-param-grid">
                  <dt>Shell</dt><dd>{{ selectedEntry.shell }}</dd>
                  <dt>模式</dt><dd>{{ selectedEntry.mode }}</dd>
                  <dt>权限</dt><dd>{{ selectedEntry.accessLabel }}</dd>
                  <dt>工作目录</dt><dd>{{ selectedEntry.cwd || '-' }}</dd>
                  <dt>Timeout</dt><dd>{{ selectedEntry.timeout === undefined ? '-' : `${selectedEntry.timeout}ms` }}</dd>
                  <dt>调用次数</dt><dd>{{ selectedEntry.callCount }}</dd>
                  <dt>开始</dt><dd>{{ formatTime(selectedEntry.startedAt) }}</dd>
                  <dt>更新</dt><dd>{{ formatTime(selectedEntry.updatedAt) }}</dd>
                  <dt>Exit Code</dt><dd>{{ selectedEntry.exitCode === undefined ? '-' : selectedEntry.exitCode }}</dd>
                  <dt>Killed</dt><dd>{{ selectedEntry.killed === undefined ? '-' : selectedEntry.killed }}</dd>
                  <dt>Dropped</dt><dd>{{ selectedEntry.droppedChars === undefined ? '-' : selectedEntry.droppedChars }}</dd>
                </dl>
              </section>
            </div>
            <AdvancedScrollbar :scroller="detailScroller" :refresh-key="detailRefreshKey" variant="minimal" />
          </div>
        </article>
      </div>

      <div v-else class="background-command-empty">暂无后台命令。</div>
    </section>
  </div>
</template>

<style scoped>
.background-command-root {
  position: relative;
  flex: 0 0 auto;
}

.background-command-trigger {
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

.background-command-trigger:hover,
.background-command-trigger:focus-visible,
.background-command-trigger.is-active {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.background-command-trigger.has-running .background-command-trigger-icon {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.background-command-trigger-icon {
  width: 16px;
  height: 16px;
}

.background-command-count {
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

.background-command-panel {
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

.background-command-header {
  min-height: 38px;
  padding: 7px 8px 7px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.background-command-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: var(--font-size-sm);
  line-height: 1.25;
}

.background-command-title span:first-child {
  font-weight: 600;
}

.background-command-title span:last-child {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.background-command-close {
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

.background-command-close:hover,
.background-command-close:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.background-command-close svg {
  width: 15px;
  height: 15px;
}

.background-command-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
}

.background-command-list-shell,
.command-detail-scroll-shell {
  position: relative;
  min-height: 0;
}

.background-command-list-shell {
  border-right: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
}

.background-command-list,
.command-detail-scroll {
  height: 100%;
  min-height: 0;
  overflow: auto;
  scrollbar-width: none;
}

.background-command-list::-webkit-scrollbar,
.command-detail-scroll::-webkit-scrollbar {
  display: none;
}

.background-command-list {
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.background-command-item {
  width: 100%;
  min-height: 70px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.background-command-item:hover,
.background-command-item:focus-visible,
.background-command-item.is-selected {
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.background-command-item.is-selected {
  box-shadow: inset 2px 0 0 var(--vscode-editorWarning-foreground, #cca700);
}

.background-command-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.command-status {
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.25;
}

.command-status.is-running {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.command-status.is-done {
  color: var(--vscode-testing-iconPassed, #4caf50);
}

.command-status.is-warning {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.command-status.is-error {
  color: var(--vscode-errorForeground);
}

.command-shell,
.command-subline,
.command-detail-id {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.command-preview,
.command-subline {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-preview {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.background-command-detail {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.command-detail-header {
  min-height: 32px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  display: flex;
  align-items: center;
  gap: 8px;
}

.command-detail-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
}

.command-detail-scroll-shell {
  flex: 1 1 auto;
}

.command-detail-scroll {
  padding: 10px 12px 12px;
}

.command-detail-section + .command-detail-section {
  margin-top: 12px;
}

.command-detail-section h3 {
  margin: 0 0 5px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1.35;
}

.command-detail-section pre,
.command-log {
  margin: 0;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.command-log + .command-log {
  margin-top: 6px;
}

.command-log.is-stderr {
  color: var(--vscode-errorForeground);
}

.command-log.is-progress {
  color: var(--vscode-descriptionForeground);
}

.command-empty-text,
.background-command-empty {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.command-param-grid {
  margin: 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 10px;
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.command-param-grid dt {
  color: var(--vscode-descriptionForeground);
}

.command-param-grid dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
}

.background-command-empty {
  padding: 16px;
}

@media (max-width: 560px) {
  .background-command-panel {
    right: 0;
    width: min(420px, calc(100vw - 24px));
  }

  .background-command-body {
    grid-template-columns: 1fr;
  }

  .background-command-list-shell {
    height: 150px;
    border-right: 0;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  }
}
</style>
