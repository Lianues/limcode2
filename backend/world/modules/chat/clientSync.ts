import { isTextPart, type ClientPatchOp, type ClientState, type ContentPart, type MessageRecord, type TextPart } from '../../../../shared/protocol';
import { defineClientStateContributor } from '../../clientSync/contributors';
import { chatStateProjectionReads, projectChatState } from './stateProjection';

export const projectChatClientState = projectChatState;

type MessagePartTextAppendPatch = Extract<ClientPatchOp, { kind: 'message.partText.append' }>;
type MessagePartInsertPatch = Extract<ClientPatchOp, { kind: 'message.part.insert' }>;

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

    if (messageMetadataChanged(old, item)) {
      patches.push({ kind: 'message.upsert', message: item });
      continue;
    }

    const contentPatches = diffMessageContent(old, item);
    if (contentPatches === undefined) {
      patches.push({ kind: 'message.upsert', message: item });
      continue;
    }
    patches.push(...contentPatches);

    if (old.status !== item.status) patches.push({ kind: 'message.status', id: item.id, status: item.status });
  }

  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) patches.push({ kind: 'message.remove', id });
  }
  return patches;
}

function messageMetadataChanged(prev: MessageRecord, next: MessageRecord): boolean {
  return prev.conversationId !== next.conversationId
    || prev.role !== next.role
    || prev.createdAt !== next.createdAt
    || prev.streamOutputDurationMs !== next.streamOutputDurationMs
    || prev.seq !== next.seq
    || JSON.stringify(prev.usageMetadata) !== JSON.stringify(next.usageMetadata);
}

/**
 * Chat 模块负责根据 MessageContent 语义决定发哪种精确 mutation。
 * 前端不再判断“应该操作哪个 part”，只机械执行这里已经算好的 index/path 操作。
 */
function diffMessageContent(prev: MessageRecord, next: MessageRecord): ClientPatchOp[] | undefined {
  if (JSON.stringify(prev.content) === JSON.stringify(next.content)) return [];
  if (prev.content.role !== next.content.role) return undefined;

  const appendPatch = partTextAppendPatch(prev, next);
  if (appendPatch) return [appendPatch];

  const insertPatch = partInsertPatch(prev, next);
  if (insertPatch) return [insertPatch];

  return undefined;
}

function partTextAppendPatch(prev: MessageRecord, next: MessageRecord): MessagePartTextAppendPatch | undefined {
  const prevParts = prev.content.parts;
  const nextParts = next.content.parts;
  if (prevParts.length !== nextParts.length) return undefined;

  let changedIndex = -1;
  for (let index = 0; index < nextParts.length; index += 1) {
    if (samePart(prevParts[index], nextParts[index])) continue;
    if (changedIndex >= 0) return undefined;
    changedIndex = index;
  }
  if (changedIndex < 0) return undefined;

  const before = prevParts[changedIndex];
  const after = nextParts[changedIndex];
  if (!isTextPart(before) || !isTextPart(after)) return undefined;
  if (!sameTextPartMetadata(before, after)) return undefined;
  if (!after.text.startsWith(before.text) || after.text === before.text) return undefined;

  return {
    kind: 'message.partText.append',
    id: next.id,
    partIndex: changedIndex,
    delta: after.text.slice(before.text.length)
  };
}

function partInsertPatch(prev: MessageRecord, next: MessageRecord): MessagePartInsertPatch | undefined {
  const prevParts = prev.content.parts;
  const nextParts = next.content.parts;
  if (nextParts.length !== prevParts.length + 1) return undefined;

  for (let index = 0; index < nextParts.length; index += 1) {
    if (!sameParts(prevParts.slice(0, index), nextParts.slice(0, index))) continue;
    if (!sameParts(prevParts.slice(index), nextParts.slice(index + 1))) continue;
    return { kind: 'message.part.insert', id: next.id, index, part: nextParts[index] };
  }

  return undefined;
}

function samePart(left: ContentPart, right: ContentPart): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameParts(left: ContentPart[], right: ContentPart[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameTextPartMetadata(left: TextPart, right: TextPart): boolean {
  const { text: _leftText, ...leftMeta } = left;
  const { text: _rightText, ...rightMeta } = right;
  return JSON.stringify(leftMeta) === JSON.stringify(rightMeta);
}
