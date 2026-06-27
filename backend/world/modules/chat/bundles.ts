import { estimateTokenCount } from 'tokenx';
import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import type { ContentPart, ContentRole, InlineDataPart, LlmUsageMetadataRecord, MessageContent, MessageRevisionReason, MsgRole, MsgStatus } from '../../../../shared/protocol';
import { isInlineDataPart } from '../../../../shared/protocol';
import {
  Conversation,
  ConversationBranchLink,
  ConversationOriginLink,
  ConversationReuseLink,
  LlmRequest,
  Message,
  MessageCurrentRevisionLink,
  MessageRevision,
  PartOf,
  Streaming,
  type ConversationOriginLinkData,
  type MessageData
} from './components';

export const ConversationBundle = defineBundle({ name: 'ConversationBundle', writes: [Conversation], mutationMode: 'create', spawns: true });
export const ConversationLinkBundle = defineBundle({ name: 'ConversationLinkBundle', writes: [ConversationReuseLink, ConversationBranchLink, ConversationOriginLink], mutationMode: 'create', spawns: true });
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

export function spawnConversationOriginLink(
  cmd: CommandSink,
  input: Omit<ConversationOriginLinkData, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number }
): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, ConversationOriginLink, {
    id: input.id ?? `col${entity}`,
    conversation: input.conversation,
    originKind: input.originKind,
    ...(input.sourceKind !== undefined ? { sourceKind: input.sourceKind } : {}),
    ...(input.sourceAgent !== undefined ? { sourceAgent: input.sourceAgent } : {}),
    ...(input.sourceAgentId !== undefined ? { sourceAgentId: input.sourceAgentId } : {}),
    ...(input.sourceConversation !== undefined ? { sourceConversation: input.sourceConversation } : {}),
    ...(input.sourceConversationId !== undefined ? { sourceConversationId: input.sourceConversationId } : {}),
    ...(input.sourceMessage !== undefined ? { sourceMessage: input.sourceMessage } : {}),
    ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.sourceToolCall !== undefined ? { sourceToolCall: input.sourceToolCall } : {}),
    ...(input.sourceToolCallId !== undefined ? { sourceToolCallId: input.sourceToolCallId } : {}),
    ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
    ...(input.sourceRunId !== undefined ? { sourceRunId: input.sourceRunId } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now
  });
  return entity;
}

export interface SpawnMessageInput {
  parent: Entity;
  role: MsgRole;
  model?: string;
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
    ...(input.model !== undefined ? { model: input.model } : {}),
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
  const usageMetadata = estimateUserContentUsage(content);
  return spawnMessage(cmd, { parent: conversation, role: 'user', parts: content.parts, status: 'complete', usageMetadata });
}

export function estimateUserInputUsage(text: string): LlmUsageMetadataRecord | undefined {
  const estimated = estimateTokenCount(text);
  if (!Number.isFinite(estimated) || estimated <= 0) return undefined;
  return { promptTokenCount: estimated, totalTokenCount: estimated, estimated: true, tokenEstimator: 'tokenx' };
}

export function estimateUserContentUsage(content: MessageContent): LlmUsageMetadataRecord | undefined {
  const visibleText = content.parts.map((part) => {
    if ('text' in part && part.thought !== true) return part.text;
    return '';
  }).join('\n');
  const textTokens = estimateTokenCount(visibleText);
  const attachmentTokens = estimateAttachmentTokens(content.parts);
  const total = textTokens + attachmentTokens;
  if (!Number.isFinite(total) || total <= 0) return undefined;
  return {
    promptTokenCount: total,
    totalTokenCount: total,
    estimated: true,
    tokenEstimator: 'tokenx',
    ...(attachmentTokens > 0 ? { attachmentTokenEstimate: attachmentTokens } : {})
  };
}

function estimateAttachmentTokens(parts: ContentPart[]): number {
  let total = 0;
  for (const part of parts) {
    if (!isInlineDataPart(part)) continue;
    total += estimateMultimodalTokens(part);
  }
  return total;
}

function estimateMultimodalTokens(part: InlineDataPart): number {
  const { mimeType, data, sizeBytes } = part.inlineData;
  const rawBytes = resolveRawBytes(data, sizeBytes);
  if (rawBytes <= 0) return 0;

  if (mimeType.startsWith('image/')) return estimateImageTokens(rawBytes);
  if (mimeType.startsWith('audio/')) return estimateAudioTokens(rawBytes);
  if (mimeType.startsWith('video/')) return estimateVideoTokens(rawBytes);
  return estimateDocumentTokens(rawBytes);
}

function resolveRawBytes(data: string | undefined, sizeBytes: number | undefined): number {
  if (sizeBytes !== undefined && sizeBytes > 0) return sizeBytes;
  if (data && data.length > 0) return Math.ceil((data.length * 3) / 4);
  return 0;
}

function estimateImageTokens(rawBytes: number): number {
  const smallThreshold = 100 * 1024;
  if (rawBytes < smallThreshold) return 258;
  const tileSize = 300 * 1024;
  const tiles = Math.ceil(rawBytes / tileSize);
  return tiles * 258;
}

function estimateAudioTokens(rawBytes: number): number {
  const bytesPerSecond = 16 * 1024;
  const seconds = rawBytes / bytesPerSecond;
  return Math.max(32, Math.ceil(seconds) * 32);
}

function estimateVideoTokens(rawBytes: number): number {
  const bytesPerSecond = 256 * 1024;
  const seconds = rawBytes / bytesPerSecond;
  return Math.max(263, Math.ceil(seconds) * 263);
}

function estimateDocumentTokens(rawBytes: number): number {
  const bytesPerPage = 100 * 1024;
  const pages = Math.max(1, Math.ceil(rawBytes / bytesPerPage));
  return pages * 258;
}


export function cloneMessageToConversation(cmd: CommandSink, conversation: Entity, message: MessageData, overrideContent?: MessageContent): Entity {
  return spawnMessage(cmd, { parent: conversation, role: message.role, model: message.model, parts: overrideContent?.parts ?? message.content.parts, status: message.status === 'streaming' ? 'error' : message.status, usageMetadata: message.usageMetadata, revisionReason: 'created' });
}

export function spawnModelMessage(cmd: CommandSink, conversation: Entity, model?: string): Entity {
  const entity = spawnMessage(cmd, { parent: conversation, role: 'model', model, parts: [], status: 'streaming' });
  cmd.add(entity, Streaming, true);
  return entity;
}

function contentRoleForMessage(role: MsgRole): ContentRole { return role; }

export function spawnToolResponseMessage(
  cmd: CommandSink,
  input: { conversation: Entity; toolCallId: string; toolName: string; status: 'success' | 'warning' | 'error'; response: unknown; parts?: Extract<ContentPart, { inlineData: unknown }>[]; durationMs?: number }
): Entity {
  return spawnMessage(cmd, {
    parent: input.conversation,
    role: 'user',
    parts: [{
      id: input.toolCallId,
      functionResponse: { name: input.toolName, response: input.response, ...(input.parts?.length ? { parts: input.parts } : {}) },
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {})
    }],
    status: input.status === 'error' ? 'error' : 'complete'
  });
}

export function spawnLlmRequest(cmd: CommandSink, input: { run: Entity; conversation: Entity; modelMessage: Entity; invocation?: Entity; requestId?: string }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, LlmRequest, {
    id: input.requestId ?? `req${entity}`,
    run: input.run,
    conversation: input.conversation,
    modelMessage: input.modelMessage,
    ...(input.invocation !== undefined ? { invocation: input.invocation } : {})
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
