import { defineStore } from 'pinia';
import { createEmptyClientState } from '@shared/clientStateSchema';
import {
  isFunctionResponsePart,
  type ClientPatchOp,
  type ClientState,
  type ConversationRecord,
  type MessageRecord
} from '@shared/protocol';
import { createClientStateDb, type ClientStateDb } from './clientStateDb';

export interface ClientStateStoreState extends ClientState {
  /** 每个 state stream 当前已应用到的顺序号，用于判断 patch 是否断链。 */
  streamSeqs: Record<string, number>;
  /** 当前 webview 聚焦的对话 id（单对话场景，由 session 驱动 + 默认回落）。 */
  currentConversationId: string;
}

/** 当前对话的模型 / 模式概要，供标签头展示。 */
export interface CurrentModelSummary {
  modeName?: string;
  model?: string;
}

const dbByStore = new WeakMap<object, ClientStateDb>();

function dbFor(store: ClientStateStoreState): ClientStateDb {
  const key = store as object;
  let db = dbByStore.get(key);
  if (!db) {
    db = createClientStateDb(store);
    dbByStore.set(key, db);
  }
  return db;
}

/**
 * 同步自后端的 ClientState 投影。
 *
 * 只负责"应用 snapshot/patch + 暴露按当前对话过滤的只读视图"，
 * 领域语义由 shared/clientStateSchema 驱动的 clientStateDb 执行器机械完成。
 */
export const useClientStateStore = defineStore('clientState', {
  state: (): ClientStateStoreState => ({
    ...createEmptyClientState(),
    streamSeqs: {},
    currentConversationId: ''
  }),
  getters: {
    currentConversation(state): ConversationRecord | undefined {
      return state.conversations.find((conversation) => conversation.id === state.currentConversationId);
    },
    /** 当前对话下、按 seq 排序、剔除纯工具响应的消息（工具响应不直接展示）。 */
    currentMessages(state): MessageRecord[] {
      return state.messages
        .filter(
          (message) =>
            message.conversationId === state.currentConversationId &&
            !message.content.parts.some(isFunctionResponsePart)
        )
        .sort((left, right) => left.seq - right.seq);
    },
    currentModelSummary(state): CurrentModelSummary {
      const agentLink =
        state.agentConversationLinks.find(
          (link) => link.conversationId === state.currentConversationId && link.role === 'default'
        ) ?? state.agentConversationLinks.find((link) => link.conversationId === state.currentConversationId);
      const agent = state.agents.find((candidate) => candidate.id === agentLink?.agentId);

      const modeLink =
        state.agentModeLinks.find((link) => link.agentId === agent?.id && link.role === 'active') ??
        state.agentModeLinks.find((link) => link.agentId === agent?.id && link.role === 'default') ??
        state.agentModeLinks.find((link) => link.agentId === agent?.id);
      const mode = state.agentModes.find((candidate) => candidate.id === modeLink?.modeId);

      const profileLink = state.modeModelProfileLinks.find(
        (link) => link.modeId === mode?.id && link.role === 'active'
      );
      const profile = state.modelProfiles.find((candidate) => candidate.id === profileLink?.modelProfileId);

      return { modeName: mode?.name, model: profile?.model };
    }
  },
  actions: {
    applyClientSnapshot(streamId: string, streamSeq: number, state: ClientState): void {
      this.streamSeqs[streamId] = streamSeq;
      if (!dbFor(this).applySnapshot(streamId, state)) return;
      this.ensureCurrentConversation();
    },
    applyClientPatch(streamId: string, streamSeq: number, patches: ClientPatchOp[]): boolean {
      const currentStreamSeq = this.streamSeqs[streamId] ?? 0;
      if (streamSeq !== currentStreamSeq + 1) return false;
      dbFor(this).applyPatches(patches);
      this.streamSeqs[streamId] = streamSeq;
      this.ensureCurrentConversation();
      return true;
    },
    setCurrentConversation(conversationId: string): void {
      if (conversationId) this.currentConversationId = conversationId;
    },
    /** Hello 未提供 conversationId（"加载默认"入口）时，待快照到达后回落 default / 首个对话。 */
    ensureCurrentConversation(): void {
      const hasCurrent =
        !!this.currentConversationId &&
        this.conversations.some((conversation) => conversation.id === this.currentConversationId);
      if (!hasCurrent) {
        this.currentConversationId =
          this.conversations.find((conversation) => conversation.id === 'default')?.id ??
          this.conversations[0]?.id ??
          '';
      }
    }
  }
});
