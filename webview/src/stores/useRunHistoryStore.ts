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
}

function activeRequestKey(active: ActiveRunDetailSelection): string | undefined {
  return active.runId ?? active.messageId;
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
      return active?.runId ? state.byConversationId[active.conversationId]?.dryRunByRunId[active.runId] : undefined;
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
    requestDryRun(conversationId: string, runId: string | undefined, includeApiKey = false, messageId?: string): void {
      if (!conversationId || (!runId && !messageId)) return;
      const key = runId ?? messageId!;
      const target = this.ensureConversationState(conversationId);
      target.dryRunLoadingByRunId[key] = true;
      target.dryRunErrorByRunId[key] = undefined;
      bridge.request(BridgeMessageType.LlmDryRunGet, { conversationId, ...(runId ? { runId } : {}), ...(messageId ? { messageId } : {}), includeApiKey }, { channel: 'state' });
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
      const messageId = this.activeDetail?.conversationId === payload.conversationId ? this.activeDetail.messageId : undefined;
      this.activeDetail = { conversationId: payload.conversationId, runId: payload.runId, ...(messageId ? { messageId } : {}) };
      target.status = 'idle';
      target.error = undefined;
    },
    applyDryRunSnapshot(payload: LlmDryRunSnapshotPayload): void {
      const target = this.ensureConversationState(payload.conversationId);
      const previousKey = this.activeDetail?.conversationId === payload.conversationId ? activeRequestKey(this.activeDetail) : undefined;
      if (previousKey) target.dryRunLoadingByRunId[previousKey] = false;
      target.dryRunByRunId[payload.runId] = payload;
      target.dryRunLoadingByRunId[payload.runId] = false;
      target.dryRunErrorByRunId[payload.runId] = undefined;
      this.activeDetail = { conversationId: payload.conversationId, runId: payload.runId, ...(this.activeDetail?.messageId ? { messageId: this.activeDetail.messageId } : {}) };
      if (!target.detailByRunId[payload.runId]) this.requestDetail(payload.conversationId, payload.runId);
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
