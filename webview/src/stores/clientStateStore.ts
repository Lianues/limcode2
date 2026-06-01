import { reactive } from 'vue';
import { createEmptyClientState } from '@shared/clientStateSchema';
import type { ClientPatchOp, ClientState } from '@shared/protocol';
import { createClientStateDb } from './clientStateDb';

interface ClientStateStore extends ClientState {
  /** 每个 state stream 当前已应用到的顺序号，用于判断 patch 是否断链。 */
  streamSeqs: Record<string, number>;
  currentConversationId: string;
  showHiddenConversations: boolean;
}

export const clientState = reactive<ClientStateStore>({
  ...createEmptyClientState(),
  streamSeqs: {},
  currentConversationId: '',
  showHiddenConversations: false
});

const clientStateDb = createClientStateDb(clientState);

export function applyClientSnapshot(streamId: string, streamSeq: number, state: ClientState): void {
  clientState.streamSeqs[streamId] = streamSeq;
  if (!clientStateDb.applySnapshot(streamId, state)) return;
  ensureCurrentConversation();
}

export function applyClientPatch(streamId: string, streamSeq: number, patches: ClientPatchOp[]): boolean {
  const currentStreamSeq = clientState.streamSeqs[streamId] ?? 0;
  if (streamSeq !== currentStreamSeq + 1) return false;
  clientStateDb.applyPatches(patches);
  clientState.streamSeqs[streamId] = streamSeq;
  ensureCurrentConversation();
  return true;
}

function ensureCurrentConversation(): void {
  const hasCurrent = !!clientState.currentConversationId && clientState.conversations.some((conversation) => conversation.id === clientState.currentConversationId);
  if (!hasCurrent) {
    clientState.currentConversationId = clientState.conversations.find((conversation) => conversation.id === 'default')?.id ?? clientState.conversations[0]?.id ?? '';
  }
}
