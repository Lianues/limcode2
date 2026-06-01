import { defineStore } from 'pinia';
import { createEmptyClientState } from '@shared/clientStateSchema';
import type { ClientPatchOp, ClientState } from '@shared/protocol';
import { createClientStateDb, type ClientStateDb } from './clientStateDb';

export interface ClientStateStoreState extends ClientState {
  /** 每个 state stream 当前已应用到的顺序号，用于判断 patch 是否断链。 */
  streamSeqs: Record<string, number>;
  currentConversationId: string;
  showHiddenConversations: boolean;
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

export const useClientStateStore = defineStore('clientState', {
  state: (): ClientStateStoreState => ({
    ...createEmptyClientState(),
    streamSeqs: {},
    currentConversationId: '',
    showHiddenConversations: false
  }),
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
    ensureCurrentConversation(): void {
      const hasCurrent = !!this.currentConversationId && this.conversations.some((conversation) => conversation.id === this.currentConversationId);
      if (!hasCurrent) {
        this.currentConversationId = this.conversations.find((conversation) => conversation.id === 'default')?.id ?? this.conversations[0]?.id ?? '';
      }
    }
  }
});
