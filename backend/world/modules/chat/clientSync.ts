import { isVisibleTextPart, type ClientPatchOp, type ClientState, type MessageRecord, type SessionRecord } from '../../../../shared/protocol';
import type { WorldReader } from '../../../ecs/types';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor, type ClientStateSlice } from '../../clientSync/contributors';
import { Message, PartOf, Session } from './components';

export function projectChatClientState(world: WorldReader): ClientStateSlice {
  const sessions: SessionRecord[] = world.query(Session).map((entity) => ({
    id: world.get(entity, Session)!.id,
    title: world.get(entity, Session)!.title
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
        content: message.content,
        status: message.status,
        createdAt: message.createdAt,
        ...(message.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: message.streamOutputDurationMs } : {}),
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
    const oldText = messageText(old);
    const nextText = messageText(item);
    if (JSON.stringify(old.content) !== JSON.stringify(item.content)) {
      if (canAppendText(old, item) && nextText.startsWith(oldText)) patches.push({ kind: 'message.appendText', id: item.id, delta: nextText.slice(oldText.length) });
      else patches.push({ kind: 'message.upsert', message: item });
    }
    if (old.status !== item.status) patches.push({ kind: 'message.status', id: item.id, status: item.status });
  }
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) patches.push({ kind: 'message.remove', id });
  }
  return patches;
}


function messageText(message: MessageRecord): string {
  return message.content.parts
    .map((part) => isVisibleTextPart(part) ? part.text : '')
    .join('');
}

function canAppendText(prev: MessageRecord, next: MessageRecord): boolean {
  const withoutText = (message: MessageRecord) => message.content.parts.filter((part) => !isVisibleTextPart(part));
  return JSON.stringify(withoutText(prev)) === JSON.stringify(withoutText(next));
}
