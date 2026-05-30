import type { ClientPatchOp, ClientState, MessageRecord, SessionRecord } from '../../../../shared/protocol';
import type { WorldReader } from '../../../ecs/types';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor, type ClientStateSlice } from '../../clientSync/contributors';
import { Message, PartOf, Session } from './components';

export function projectChatClientState(world: WorldReader): ClientStateSlice {
  const sessions: SessionRecord[] = world.query(Session).map((entity) => ({
    id: world.get(entity, Session)!.id
  }));

  const messages: MessageRecord[] = world
    .query(Message, PartOf)
    .filter((entity) => world.has(world.get(entity, PartOf)!.parent, Session))
    .map((entity) => {
      const message = world.get(entity, Message)!;
      const sessionEntity = world.get(entity, PartOf)!.parent;
      return {
        id: message.id,
        sessionId: world.get(sessionEntity, Session)!.id,
        role: message.role,
        text: message.text,
        status: message.status,
        seq: message.seq
      };
    })
    .sort((a, b) => a.seq - b.seq);

  return { sessions, messages };
}

export function diffChatClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  patches.push(
    ...diffUpsertRemove(
      prev.sessions,
      next.sessions,
      (session): ClientPatchOp => ({ kind: 'session.upsert', session }),
      (id): ClientPatchOp => ({ kind: 'session.remove', id })
    )
  );
  patches.push(...diffMessages(prev.messages, next.messages));
  return patches;
}

export const chatClientSyncContributor = defineClientStateContributor({
  key: 'chat',
  reads: { components: [Message, PartOf, Session] },
  project: projectChatClientState,
  diff: diffChatClientState,
  worker: {
    modulePath: '../world/modules/chat/clientSync',
    projectExport: 'projectChatClientState',
    diffExport: 'diffChatClientState'
  }
});

function diffMessages(prev: MessageRecord[], next: MessageRecord[]): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  const prevMap = new Map(prev.map((item) => [item.id, item]));
  const nextMap = new Map(next.map((item) => [item.id, item]));
  for (const item of next) {
    const old = prevMap.get(item.id);
    if (!old) {
      patches.push({ kind: 'message.upsert', message: item });
      continue;
    }
    if (old.text !== item.text) {
      if (item.text.startsWith(old.text)) patches.push({ kind: 'message.appendText', id: item.id, delta: item.text.slice(old.text.length) });
      else patches.push({ kind: 'message.upsert', message: item });
    }
    if (old.status !== item.status) patches.push({ kind: 'message.status', id: item.id, status: item.status });
  }
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) patches.push({ kind: 'message.remove', id });
  }
  return patches;
}
