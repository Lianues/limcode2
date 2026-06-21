import { defineStore } from 'pinia';
import {
  BridgeMessageType,
  type ConversationRunDetailRecord,
  type ConversationRunHistoryPageInfo,
  type ConversationRunSummaryRecord,
  type LlmDryRunSnapshotPayload
} from '@shared/protocol';
import { bridge } from '@webview/transport';

interface ConversationRunHistoryUiState {
  status: 'idle' | 'loadingPage' | 'loadingDetail' | 'error';
  error?: string;
  pageInfo?: ConversationRunHistoryPageInfo;
  runs: ConversationRunSummaryRecord[];
  runById: Record<string, ConversationRunSummaryRecord>;
  detailByRunId: Record<string, ConversationRunDetailRecord>;
  dryRunByRunId: Record<string, LlmDryRunSnapshotPayload>;
  dryRunLoadingByRunId: Record<string, boolean>;
  dryRunErrorByRunId: Record<string, string | undefined>;
}

interface ActiveRunDetailSelection {
  conversationId: string;
  runId?: string;
  messageId?: string;
  invocationId?: string;
  compressionBlockId?: string;
}

function activeRequestKey(active: ActiveRunDetailSelection): string | undefined {
  return active.invocationId ?? active.runId ?? active.messageId ?? active.compressionBlockId;
}

function invocationIdForDetail(payload: ConversationRunDetailRecord, messageId?: string, fallbackInvocationId?: string): string | undefined {
  const messageLink = messageId
    ? payload.state.messageLlmInvocationLinks.find((link) => link.messageId === messageId)
    : undefined;
  if (messageLink) return messageLink.invocationId;

  const invocationById = new Map(payload.state.llmInvocations.map((invocation) => [invocation.id, invocation]));
  let selectedId = fallbackInvocationId;
  let selectedCreatedAt = selectedId ? invocationById.get(selectedId)?.createdAt ?? -Infinity : -Infinity;
  for (const link of payload.state.runLlmInvocationLinks) {
    if (link.runId !== payload.runId) continue;
    const invocation = invocationById.get(link.invocationId);
    if (!invocation) continue;
    if (invocation.createdAt > selectedCreatedAt || (invocation.createdAt === selectedCreatedAt && invocation.id.localeCompare(selectedId ?? '') > 0)) {
      selectedId = invocation.id;
      selectedCreatedAt = invocation.createdAt;
    }
  }
  return selectedId;
}

interface RunHistoryStoreState {
  byConversationId: Record<string, ConversationRunHistoryUiState>;
  activeDetail?: ActiveRunDetailSelection;
  detailPanelOpen: boolean;
}

function createConversationState(): ConversationRunHistoryUiState {
  return {
    status: 'idle',
    runs: [],
    runById: {},
    detailByRunId: {},
    dryRunByRunId: {},
    dryRunLoadingByRunId: {},
    dryRunErrorByRunId: {}
  };
}

export const useRunHistoryStore = defineStore('runHistory', {
  state: (): RunHistoryStoreState => ({
    byConversationId: {},
    activeDetail: undefined,
    detailPanelOpen: false
  }),
  getters: {
    conversationRunHistory: (state) => (conversationId: string): ConversationRunHistoryUiState => {
      return state.byConversationId[conversationId] ?? createConversationState();
    },
    runDetail: (state) => (conversationId: string, runId: string): ConversationRunDetailRecord | undefined => {
      return state.byConversationId[conversationId]?.detailByRunId[runId];
    },
    activeDetailState(state): ConversationRunHistoryUiState | undefined {
      return state.activeDetail ? state.byConversationId[state.activeDetail.conversationId] : undefined;
    },
    activeDetailRecord(state): ConversationRunDetailRecord | undefined {
      const active = state.activeDetail;
      return active?.runId ? state.byConversationId[active.conversationId]?.detailByRunId[active.runId] : undefined;
    },
    activeDetailSummary(state): ConversationRunSummaryRecord | undefined {
      const active = state.activeDetail;
      return active?.runId ? state.byConversationId[active.conversationId]?.runById[active.runId] : undefined;
    },
    activeDryRun(state): LlmDryRunSnapshotPayload | undefined {
      const active = state.activeDetail;
      const key = active ? activeRequestKey(active) : undefined;
      return active && key ? state.byConversationId[active.conversationId]?.dryRunByRunId[key] : undefined;
    },
    activeDryRunLoading(state): boolean {
      const active = state.activeDetail;
      const key = active ? activeRequestKey(active) : undefined;
      return active && key ? !!state.byConversationId[active.conversationId]?.dryRunLoadingByRunId[key] : false;
    },
    activeDryRunError(state): string | undefined {
      const active = state.activeDetail;
      const key = active ? activeRequestKey(active) : undefined;
      return active && key ? state.byConversationId[active.conversationId]?.dryRunErrorByRunId[key] : undefined;
    }
  },
  actions: {
    requestPage(conversationId: string, cursor?: string, limit = 20): void {
      if (!conversationId) return;
      const target = this.ensureConversationState(conversationId);
      target.status = 'loadingPage';
      target.error = undefined;
      bridge.request(BridgeMessageType.RunHistoryPageGet, { conversationId, cursor, limit }, { channel: 'state' });
    },
    requestDetail(conversationId: string, runId: string | undefined, messageId?: string): void {
      if (!conversationId || (!runId && !messageId)) return;
      const target = this.ensureConversationState(conversationId);
      target.status = 'loadingDetail';
      target.error = undefined;
      bridge.request(BridgeMessageType.RunHistoryDetailGet, { conversationId, ...(runId ? { runId } : {}), ...(messageId ? { messageId } : {}) }, { channel: 'state' });
    },
    openDetail(conversationId: string, runId: string | undefined, messageId?: string): void {
      if (!conversationId || (!runId && !messageId)) return;
      this.activeDetail = { conversationId, ...(runId ? { runId } : {}), ...(messageId ? { messageId } : {}) };
      this.detailPanelOpen = true;
      this.requestDetail(conversationId, runId, messageId);
    },
    openCompressionDetail(conversationId: string, compressionBlockId: string): void {
      if (!conversationId || !compressionBlockId) return;
      this.activeDetail = { conversationId, compressionBlockId };
      this.detailPanelOpen = true;
      this.ensureConversationState(conversationId).status = 'idle';
    },
    requestDryRun(conversationId: string, runId: string | undefined, includeApiKey = false, messageId?: string, invocationId?: string, compressionBlockId?: string): void {
      if (!conversationId || (!runId && !messageId && !invocationId && !compressionBlockId)) return;
      const key = invocationId ?? runId ?? messageId ?? compressionBlockId!;
      const target = this.ensureConversationState(conversationId);
      target.dryRunLoadingByRunId[key] = true;
      target.dryRunErrorByRunId[key] = undefined;
      if (this.activeDetail?.conversationId === conversationId) this.activeDetail = { ...this.activeDetail, ...(invocationId ? { invocationId } : {}) };
      bridge.request(BridgeMessageType.LlmDryRunGet, { conversationId, ...(runId ? { runId } : {}), ...(messageId ? { messageId } : {}), ...(invocationId ? { invocationId } : {}), ...(compressionBlockId ? { compressionBlockId } : {}), includeApiKey }, { channel: 'state' });
    },
    applyPageSnapshot(payload: { conversationId: string; runs: ConversationRunSummaryRecord[]; pageInfo: ConversationRunHistoryPageInfo }): void {
      const target = this.ensureConversationState(payload.conversationId);
      target.runs = payload.runs;
      target.pageInfo = payload.pageInfo;
      for (const run of payload.runs) target.runById[run.id] = run;
      target.status = 'idle';
      target.error = undefined;
    },
    applyDetailSnapshot(payload: ConversationRunDetailRecord): void {
      const target = this.ensureConversationState(payload.conversationId);
      target.detailByRunId[payload.runId] = payload;
      if (payload.summary) target.runById[payload.runId] = payload.summary;
      const previousActive = this.activeDetail?.conversationId === payload.conversationId ? this.activeDetail : undefined;
      const messageId = previousActive?.messageId;
      const invocationId = invocationIdForDetail(payload, messageId, previousActive?.invocationId);
      this.activeDetail = { conversationId: payload.conversationId, runId: payload.runId, ...(messageId ? { messageId } : {}), ...(invocationId ? { invocationId } : {}) };
      target.status = 'idle';
      target.error = undefined;
    },
    applyDryRunSnapshot(payload: LlmDryRunSnapshotPayload): void {
      const target = this.ensureConversationState(payload.conversationId);
      const previousKey = this.activeDetail?.conversationId === payload.conversationId ? activeRequestKey(this.activeDetail) : undefined;
      if (previousKey) target.dryRunLoadingByRunId[previousKey] = false;
      const key = payload.invocationId ?? payload.runId ?? payload.compressionBlockId;
      if (!key) return;
      target.dryRunByRunId[key] = payload;
      target.dryRunLoadingByRunId[key] = false;
      target.dryRunErrorByRunId[key] = undefined;
      this.activeDetail = { conversationId: payload.conversationId, ...(payload.runId ? { runId: payload.runId } : {}), ...(this.activeDetail?.messageId ? { messageId: this.activeDetail.messageId } : {}), ...(this.activeDetail?.compressionBlockId ? { compressionBlockId: this.activeDetail.compressionBlockId } : {}), ...(payload.invocationId ? { invocationId: payload.invocationId } : {}) };
      if (payload.runId && !target.detailByRunId[payload.runId]) this.requestDetail(payload.conversationId, payload.runId);
    },
    setError(message: string): void {
      for (const target of Object.values(this.byConversationId)) {
        if (target.status === 'loadingPage' || target.status === 'loadingDetail') {
          target.status = 'error';
          target.error = message;
        }
      }
      const active = this.activeDetail;
      if (active) {
        const key = activeRequestKey(active);
        const target = this.byConversationId[active.conversationId];
        if (target && key && target.dryRunLoadingByRunId[key]) {
          target.dryRunLoadingByRunId[key] = false;
          target.dryRunErrorByRunId[key] = message;
        }
      }
    },
    closeDetail(): void {
      this.detailPanelOpen = false;
      this.activeDetail = undefined;
    },
    ensureConversationState(conversationId: string): ConversationRunHistoryUiState {
      const existing = this.byConversationId[conversationId];
      if (existing) return existing;
      const next = createConversationState();
      this.byConversationId[conversationId] = next;
      return next;
    }
  }
});
