import { estimateTokenCount } from 'tokenx';
import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import type { ContentPart, ContentRole, LlmUsageMetadataRecord, MessageContent, MessageRevisionReason, MsgRole, MsgStatus } from '../../../../shared/protocol';
import { Conversation, ConversationBranchLink, ConversationReuseLink, LlmRequest, Message, MessageCurrentRevisionLink, MessageRevision, PartOf, Streaming, type MessageData } from './components';

export const ConversationBundle = defineBundle({ name: 'ConversationBundle', writes: [Conversation], mutationMode: 'create', spawns: true });
export const ConversationLinkBundle = defineBundle({ name: 'ConversationLinkBundle', writes: [ConversationReuseLink, ConversationBranchLink], mutationMode: 'create', spawns: true });
export const MessageBundle = defineBundle({ name: 'MessageBundle', writes: [Message, PartOf, MessageRevision, MessageCurrentRevisionLink], mutationMode: 'create', spawns: true });
export const UserMessageBundle = MessageBundle;
export const ModelMessageBundle = defineBundle({ name: 'ModelMessageBundle', writes: [Message, PartOf, Streaming, MessageRevision, MessageCurrentRevisionLink], mutationMode: 'create', spawns: true });
export const ToolResultMessageBundle = MessageBundle;
export const LlmRequestBundle = defineBundle({ name: 'LlmRequestBundle', writes: [LlmRequest], mutationMode: 'create', spawns: true });

export function spawnConversation(cmd: CommandSink, input: { id: string; title?: string; visibility?: 'visible' | 'hidden' | 'collapsed' }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, Conversation, { id: input.id, title: input.title, visibility: input.visibility ?? 'visible' });
  return entity;
}

export function spawnConversationReuseLink(cmd: CommandSink, input: { key: string; conversation: Entity; agent?: Entity }): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, ConversationReuseLink, { id: `crl${entity}`, key: input.key, conversation: input.conversation, ...(input.agent !== undefined ? { agent: input.agent } : {}), createdAt: now, updatedAt: now });
  return entity;
}

export function spawnConversationBranchLink(cmd: CommandSink, input: { sourceConversation: Entity; targetConversation: Entity; sourceRevision?: Entity; kind: 'fork' | 'branch_from_revision' }): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, ConversationBranchLink, { id: `cbl${entity}`, sourceConversation: input.sourceConversation, targetConversation: input.targetConversation, ...(input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {}), kind: input.kind, createdAt: now, updatedAt: now });
  return entity;
}

export interface SpawnMessageInput {
  parent: Entity;
  role: MsgRole;
  parts?: ContentPart[];
  status?: MsgStatus;
  revisionReason?: MessageRevisionReason;
  usageMetadata?: LlmUsageMetadataRecord;
}

export function spawnMessage(cmd: CommandSink, input: SpawnMessageInput): Entity {
  const entity = cmd.spawn();
  const createdAt = Date.now();
  const seq = nextMessageSeq(input.parent);
  const content: MessageContent = {
    role: contentRoleForMessage(input.role),
    parts: input.parts ?? []
  };
  cmd.add(entity, Message, {
    id: `m${entity}`,
    role: input.role,
    content,
    status: input.status ?? 'complete',
    seq,
    createdAt,
    usageMetadata: input.usageMetadata
  });
  cmd.add(entity, PartOf, { parent: input.parent });
  spawnMessageRevision(cmd, entity, content, input.revisionReason ?? 'created');
  return entity;
}

export function spawnMessageRevision(cmd: CommandSink, message: Entity, content: MessageContent, reason: MessageRevisionReason): Entity {
  const revision = cmd.spawn();
  cmd.add(revision, MessageRevision, {
    id: `rev${revision}`,
    content,
    createdAt: Date.now(),
    reason
  });
  cmd.add(revision, PartOf, { parent: message });
  const link = cmd.spawn();
  cmd.add(link, MessageCurrentRevisionLink, { id: `mcr${link}`, message, revision });
  return revision;
}

export function spawnUserMessage(cmd: CommandSink, conversation: Entity, text: string): Entity {
  return spawnMessage(cmd, { parent: conversation, role: 'user', parts: [{ text }], status: 'complete', usageMetadata: estimateUserInputUsage(text) });
}

export function spawnUserContentMessage(cmd: CommandSink, conversation: Entity, content: MessageContent): Entity {
  const visibleText = content.parts.map((part) => {
    if ('text' in part && part.thought !== true) return part.text;
    if ('contextReference' in part) return part.contextReference.text ?? part.contextReference.title ?? '';
    return '';
  }).join('\n');
  return spawnMessage(cmd, { parent: conversation, role: 'user', parts: content.parts, status: 'complete', usageMetadata: estimateUserInputUsage(visibleText) });
}

export function estimateUserInputUsage(text: string): LlmUsageMetadataRecord | undefined {
  const estimated = estimateTokenCount(text);
  if (!Number.isFinite(estimated) || estimated <= 0) return undefined;
  return { promptTokenCount: estimated, totalTokenCount: estimated, estimated: true, tokenEstimator: 'tokenx' };
}

export function cloneMessageToConversation(cmd: CommandSink, conversation: Entity, message: MessageData, overrideContent?: MessageContent): Entity {
  return spawnMessage(cmd, { parent: conversation, role: message.role, parts: overrideContent?.parts ?? message.content.parts, status: message.status === 'streaming' ? 'error' : message.status, usageMetadata: message.usageMetadata, revisionReason: 'created' });
}

export function spawnModelMessage(cmd: CommandSink, conversation: Entity): Entity {
  const entity = spawnMessage(cmd, { parent: conversation, role: 'model', parts: [], status: 'streaming' });
  cmd.add(entity, Streaming, true);
  return entity;
}

function contentRoleForMessage(role: MsgRole): ContentRole { return role; }

export function spawnToolResponseMessage(
  cmd: CommandSink,
  input: { conversation: Entity; toolCallId: string; toolName: string; status: 'success' | 'warning' | 'error'; response: unknown; durationMs?: number }
): Entity {
  return spawnMessage(cmd, {
    parent: input.conversation,
    role: 'user',
    parts: [{
      id: input.toolCallId,
      functionResponse: { name: input.toolName, response: input.response },
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {})
    }],
    status: input.status === 'error' ? 'error' : 'complete'
  });
}

export function spawnLlmRequest(cmd: CommandSink, input: { run: Entity; conversation: Entity; modelMessage: Entity }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, LlmRequest, {
    id: `req${entity}`,
    run: input.run,
    conversation: input.conversation,
    modelMessage: input.modelMessage
  });
  return entity;
}

const MESSAGE_SEQ_STEP = 100_000;
const conversationMaxMessageSeq = new Map<Entity, number>();

export function rememberHydratedMessageSeq(conversation: Entity, seq: number): void {
  const current = conversationMaxMessageSeq.get(conversation) ?? 0;
  if (seq > current) conversationMaxMessageSeq.set(conversation, seq);
}

export function resetMessageSeqState(): void {
  conversationMaxMessageSeq.clear();
}

function nextMessageSeq(conversation: Entity): number {
  const current = conversationMaxMessageSeq.get(conversation) ?? 0;
  const next = current > 0 ? current + MESSAGE_SEQ_STEP : MESSAGE_SEQ_STEP;
  conversationMaxMessageSeq.set(conversation, next);
  return next;
}
