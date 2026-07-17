import { defineStore } from 'pinia';
import type { WebviewClientMeta } from '@shared/protocol';

/** 当前 webview 这个"任务单元"承载的视图类型。 */
export type SessionViewKind = 'chat' | 'globalSettings' | 'workflowSettings' | 'agentSettings' | 'planDetail' | 'unknown';

interface SessionState {
  /** 视图类型，由后端 Hello.meta.kind 决定。 */
  viewKind: SessionViewKind;
  /** 本 webview 绑定的对话 id（chat 视图）。 */
  conversationId: string;
  /** Plan 详情页绑定的工具调用 id。 */
  toolCallId: string;
  /** Plan 详情页绑定的 PlanProposal id。 */
  planProposalId: string;
  /** 连接状态：是否已收到 Hello。 */
  status: 'connecting' | 'ready';
}

/**
 * 任务单元身份 store。
 *
 * 一个 webview = 一个对话（或一个全局设置页）。这里只保存"我是谁"，
 * 不持有业务数据；业务数据在 useClientStateStore，设置数据在各 settings store。
 */
export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({
    viewKind: 'unknown',
    conversationId: '',
    toolCallId: '',
    planProposalId: '',
    status: 'connecting'
  }),
  getters: {
    isChat: (state): boolean => state.viewKind === 'chat',
    isGlobalSettings: (state): boolean => state.viewKind === 'globalSettings',
    isWorkflowSettings: (state): boolean => state.viewKind === 'workflowSettings',
    isAgentSettings: (state): boolean => state.viewKind === 'agentSettings',
    isPlanDetail: (state): boolean => state.viewKind === 'planDetail'
  },
  actions: {
    applyHello(meta: WebviewClientMeta | undefined): void {
      this.viewKind = meta?.kind === 'globalSettings'
        ? 'globalSettings'
        : meta?.kind === 'workflowSettings'
          ? 'workflowSettings'
          : meta?.kind === 'agentSettings'
            ? 'agentSettings'
            : meta?.kind === 'planDetail'
              ? 'planDetail'
              : 'chat';
      if (meta?.conversationId) this.conversationId = meta.conversationId;
      this.toolCallId = meta?.toolCallId ?? '';
      this.planProposalId = meta?.planProposalId ?? '';
      this.status = 'ready';
    },
    setConversationId(conversationId: string): void {
      this.conversationId = conversationId;
    }
  }
});
