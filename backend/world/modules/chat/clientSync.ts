import { isTextPart, isVisibleTextPart, type ClientPatchOp, type ClientState, type ConversationBranchLinkRecord, type ConversationRecord, type ConversationReuseLinkRecord, type MessageCurrentRevisionLinkRecord, type MessageRecord, type MessageRevisionRecord, type TextPart } from '../../../../shared/protocol';
import type { WorldReader } from '../../../ecs/types';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor, type ClientStateSlice } from '../../clientSync/contributors';
import { Agent } from '../agent/components';
import { Conversation, ConversationBranchLink, ConversationReuseLink, Message, MessageCurrentRevisionLink, MessageRevision, PartOf } from './components';

export function projectChatClientState(world: WorldReader): ClientStateSlice {
  const conversations: ConversationRecord[] = world.query(Conversation).map((entity) => ({
    id: world.get(entity, Conversation)!.id,
    title: world.get(entity, Conversation)!.title,
    visibility: world.get(entity, Conversation)!.visibility
  }));

  const conversationReuseLinks: ConversationReuseLinkRecord[] = world
    .query(ConversationReuseLink)
    .map((entity) => buildConversationReuseLinkRecord(world, entity))
    .filter((item): item is ConversationReuseLinkRecord => item !== undefined);

  const conversationBranchLinks: ConversationBranchLinkRecord[] = world
    .query(ConversationBranchLink)
    .map((entity) => buildConversationBranchLinkRecord(world, entity))
    .filter((item): item is ConversationBranchLinkRecord => item !== undefined);

  const messages: MessageRecord[] = world
    .query(Message, PartOf)
    .filter((entity) => world.has(world.get(entity, PartOf)!.parent, Conversation))
    .map((entity) => {
      const message = world.get(entity, Message)!;
      const conversationEntity = world.get(entity, PartOf)!.parent;
      return {
        id: message.id,
        conversationId: world.get(conversationEntity, Conversation)!.id,
        role: message.role,
        content: message.content,
        status: message.status,
        createdAt: message.createdAt,
        ...(message.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: message.streamOutputDurationMs } : {}),
        ...(message.usageMetadata !== undefined ? { usageMetadata: message.usageMetadata } : {}),
        seq: message.seq
      };
    })
    .sort((a, b) => a.seq - b.seq);

  const messageRevisions: MessageRevisionRecord[] = world
    .query(MessageRevision, PartOf)
    .map((entity) => buildMessageRevisionRecord(world, entity))
    .filter((item): item is MessageRevisionRecord => item !== undefined);

  const messageCurrentRevisionLinks: MessageCurrentRevisionLinkRecord[] = world
    .query(MessageCurrentRevisionLink)
    .map((entity) => buildMessageCurrentRevisionLinkRecord(world, entity))
    .filter((item): item is MessageCurrentRevisionLinkRecord => item !== undefined);

  return { conversations, conversationReuseLinks, conversationBranchLinks, messages, messageRevisions, messageCurrentRevisionLinks };
}

export function diffChatClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  patches.push(
    ...diffUpsertRemove(
      prev.conversations,
      next.conversations,
      (conversation): ClientPatchOp => ({ kind: 'conversation.upsert', conversation }),
      (id): ClientPatchOp => ({ kind: 'conversation.remove', id })
    )
  );
  patches.push(...diffUpsertRemove(prev.conversationReuseLinks, next.conversationReuseLinks, (link): ClientPatchOp => ({ kind: 'conversationReuseLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'conversationReuseLink.remove', id })));
  patches.push(...diffUpsertRemove(prev.conversationBranchLinks, next.conversationBranchLinks, (link): ClientPatchOp => ({ kind: 'conversationBranchLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'conversationBranchLink.remove', id })));
  patches.push(...diffMessages(prev.messages, next.messages));
  patches.push(
    ...diffUpsertRemove(prev.messageRevisions, next.messageRevisions, (revision): ClientPatchOp => ({ kind: 'messageRevision.upsert', revision }), (id): ClientPatchOp => ({ kind: 'messageRevision.remove', id }))
  );
  patches.push(
    ...diffUpsertRemove(prev.messageCurrentRevisionLinks, next.messageCurrentRevisionLinks, (link): ClientPatchOp => ({ kind: 'messageCurrentRevisionLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'messageCurrentRevisionLink.remove', id }))
  );
  return patches;
}

export const chatClientSyncContributor = defineClientStateContributor({
  key: 'chat',
  reads: { components: [Agent, Message, MessageRevision, MessageCurrentRevisionLink, PartOf, Conversation, ConversationReuseLink, ConversationBranchLink] },
  project: projectChatClientState,
  diff: diffChatClientState,
  worker: {
    modulePath: '../world/modules/chat/clientSync',
    projectExport: 'projectChatClientState',
    diffExport: 'diffChatClientState'
  }
});

function buildConversationReuseLinkRecord(world: WorldReader, entity: number): ConversationReuseLinkRecord | undefined {
  const link = world.get(entity, ConversationReuseLink);
  if (!link) return undefined;
  const conversation = world.get(link.conversation, Conversation);
  if (!conversation) return undefined;
  const agent = link.agent !== undefined ? world.get(link.agent, Agent) : undefined;
  return { id: link.id, key: link.key, conversationId: conversation.id, ...(agent ? { agentId: agent.id } : {}) };
}

function buildConversationBranchLinkRecord(world: WorldReader, entity: number): ConversationBranchLinkRecord | undefined {
  const link = world.get(entity, ConversationBranchLink);
  if (!link) return undefined;
  const sourceConversation = world.get(link.sourceConversation, Conversation);
  const targetConversation = world.get(link.targetConversation, Conversation);
  const sourceRevision = link.sourceRevision !== undefined ? world.get(link.sourceRevision, MessageRevision) : undefined;
  if (!sourceConversation || !targetConversation) return undefined;
  return { id: link.id, sourceConversationId: sourceConversation.id, targetConversationId: targetConversation.id, ...(sourceRevision ? { sourceRevisionId: sourceRevision.id } : {}), kind: link.kind };
}

function buildMessageRevisionRecord(world: WorldReader, entity: number): MessageRevisionRecord | undefined {
  const revision = world.get(entity, MessageRevision);
  const messageEntity = world.get(entity, PartOf)?.parent;
  if (!revision || messageEntity === undefined) return undefined;
  const message = world.get(messageEntity, Message);
  const conversationEntity = messageEntity === undefined ? undefined : world.get(messageEntity, PartOf)?.parent;
  const conversation = conversationEntity === undefined ? undefined : world.get(conversationEntity, Conversation);
  if (!message || !conversation) return undefined;
  return { id: revision.id, messageId: message.id, conversationId: conversation.id, content: revision.content, createdAt: revision.createdAt, reason: revision.reason };
}

function buildMessageCurrentRevisionLinkRecord(world: WorldReader, entity: number): MessageCurrentRevisionLinkRecord | undefined {
  const link = world.get(entity, MessageCurrentRevisionLink);
  if (!link) return undefined;
  const message = world.get(link.message, Message);
  const revision = world.get(link.revision, MessageRevision);
  if (!message || !revision) return undefined;
  return { id: link.id, messageId: message.id, revisionId: revision.id };
}

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
