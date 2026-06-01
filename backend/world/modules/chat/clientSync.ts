import { isTextPart, isVisibleTextPart, type ClientPatchOp, type ClientState, type MessageRecord, type TextPart } from '../../../../shared/protocol';
import { defineClientStateContributor } from '../../clientSync/contributors';
import { chatStateProjectionReads, projectChatState } from './stateProjection';

export const projectChatClientState = projectChatState;

export function diffChatClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  return diffMessages(prev.messages, next.messages);
}

export const chatClientSyncContributor = defineClientStateContributor({
  key: 'chat',
  tables: [
    'conversations',
    'conversationReuseLinks',
    'conversationBranchLinks',
    'messages',
    'messageRevisions',
    'messageCurrentRevisionLinks'
  ],
  reads: chatStateProjectionReads,
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
    if (messageMetadataChanged(old, item)) {
      patches.push({ kind: 'message.upsert', message: item });
      continue;
    }

    if (JSON.stringify(old.content) !== JSON.stringify(item.content)) {
      const thoughtPatch = thoughtAppendPatch(old, item);
      if (thoughtPatch) patches.push(thoughtPatch);
      else if (canAppendText(old, item) && nextText.startsWith(oldText)) patches.push({ kind: 'message.appendText', id: item.id, delta: nextText.slice(oldText.length) });
      else patches.push({ kind: 'message.upsert', message: item });
    }
    if (old.status !== item.status) patches.push({ kind: 'message.status', id: item.id, status: item.status });
  }
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) patches.push({ kind: 'message.remove', id });
  }
  return patches;
}

function messageMetadataChanged(prev: MessageRecord, next: MessageRecord): boolean {
  return prev.createdAt !== next.createdAt
    || prev.streamOutputDurationMs !== next.streamOutputDurationMs
    || JSON.stringify(prev.usageMetadata) !== JSON.stringify(next.usageMetadata);
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

function thoughtAppendPatch(prev: MessageRecord, next: MessageRecord): ClientPatchOp | undefined {
  const prevParts = prev.content.parts;
  const nextParts = next.content.parts;

  if (nextParts.length === prevParts.length + 1 && sameParts(prevParts, nextParts.slice(0, -1))) {
    const part = nextParts[nextParts.length - 1];
    if (isOpenThoughtPart(part) && part.text) {
      return { kind: 'message.appendThought', id: next.id, partIndex: nextParts.length - 1, delta: part.text, ...thoughtPatchMetadata(part) };
    }
  }

  if (nextParts.length !== prevParts.length) return undefined;
  for (let index = 0; index < nextParts.length; index += 1) {
    const before = prevParts[index];
    const after = nextParts[index];
    if (!isOpenThoughtPart(before) || !isOpenThoughtPart(after)) continue;
    if (!after.text.startsWith(before.text) || after.text === before.text) continue;
    if (!sameThoughtMetadata(before, after)) continue;
    if (!sameParts(prevParts.slice(0, index), nextParts.slice(0, index))) continue;
    if (!sameParts(prevParts.slice(index + 1), nextParts.slice(index + 1))) continue;
    return { kind: 'message.appendThought', id: next.id, partIndex: index, delta: after.text.slice(before.text.length), ...thoughtPatchMetadata(after) };
  }

  return undefined;
}

function isOpenThoughtPart(part: unknown): part is TextPart {
  return !!part && typeof part === 'object' && isTextPart(part as ContentPartLike) && (part as TextPart).thought === true && (part as TextPart).thoughtDurationMs === undefined;
}

type ContentPartLike = Parameters<typeof isTextPart>[0];

function sameParts(left: unknown[], right: unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameThoughtMetadata(left: TextPart, right: TextPart): boolean {
  const { text: _leftText, ...leftMeta } = left;
  const { text: _rightText, ...rightMeta } = right;
  return JSON.stringify(leftMeta) === JSON.stringify(rightMeta);
}

function thoughtPatchMetadata(part: TextPart): Pick<Extract<ClientPatchOp, { kind: 'message.appendThought' }>, 'thoughtSignature'> {
  return {
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
  };
}
