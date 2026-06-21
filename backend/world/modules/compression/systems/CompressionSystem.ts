import { estimateTokenCount } from 'tokenx';
import { defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { AgentRun } from '../../agentRun/components';
import { Conversation, Message, MessageCurrentRevisionLink, MessageRevision, PartOf } from '../../chat/components';
import { conversationMessages } from '../../chat/queries';
import { LlmEventType } from '../../llm/events';
import type { LlmCompactDonePayload, LlmCompactErrorPayload } from '../../llm/events';
import { CompressionBlock, CompressionBlockSourceLink, CompressionContextVariant, RunCompressionBlockLink } from '../components';
import { CompressionEventType } from '../events';
import type { CompressionBlockRecord, ContentPart, MessageContent } from '../../../../../shared/protocol';
import { isFileDataPart, isFunctionCallPart, isFunctionResponsePart, isInlineDataPart, isProviderContextPart, isTextPart } from '../../../../../shared/protocol';

const COMPRESSION_COMPONENTS = [
  Conversation,
  Message,
  PartOf,
  MessageRevision,
  MessageCurrentRevisionLink,
  AgentRun,
  CompressionBlock,
  CompressionBlockSourceLink,
  CompressionContextVariant,
  RunCompressionBlockLink
] as const;

export const CompressionSystem = defineSystem({
  name: 'CompressionSystem',
  access: {
    reads: { components: COMPRESSION_COMPONENTS },
    writes: { components: COMPRESSION_COMPONENTS, mutationMode: 'update' },
    events: {
      read: [
        CompressionEventType.Create,
        CompressionEventType.Delete,
        CompressionEventType.Update,
        CompressionEventType.Regenerate,
        CompressionEventType.Disable,
        CompressionEventType.Enable,
        LlmEventType.CompactDone,
        LlmEventType.CompactError
      ],
      emit: [CompressionEventType.Create]
    },
    effects: { emit: ['llm.compact', 'llm.abort'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, CompressionEventType.Delete)) deleteCompressionBlock(world, cmd, payload.blockId);
    for (const payload of readEvents(ctx, CompressionEventType.Disable)) setBlockDisabled(world, cmd, payload.blockId, true);
    for (const payload of readEvents(ctx, CompressionEventType.Enable)) setBlockDisabled(world, cmd, payload.blockId, false);
    for (const payload of readEvents(ctx, CompressionEventType.Update)) updateCompressionBlock(world, cmd, payload);
    for (const payload of readEvents(ctx, CompressionEventType.Regenerate)) regenerateCompressionBlock(world, cmd, payload.blockId, payload.conversationId, payload.methodConfigId);
    for (const payload of readEvents(ctx, CompressionEventType.Create)) createCompressionBlock(world, cmd, payload);
    for (const payload of readEvents(ctx, LlmEventType.CompactDone) as LlmCompactDonePayload[]) completeCompressionBlock(world, cmd, payload);
    for (const payload of readEvents(ctx, LlmEventType.CompactError) as LlmCompactErrorPayload[]) failCompressionBlock(world, cmd, payload);
  }
});

function createCompressionBlock(
  world: WorldReader,
  cmd: CommandSink,
  payload: { conversationId: string; startMessageId?: string; endMessageId?: string; methodConfigId?: string; methodKind?: CompressionBlockRecord['methodKind']; trigger?: 'manual' | 'auto' }
): void {
  const conversation = findConversation(world, payload.conversationId);
  if (conversation === undefined) return;
  const selected = selectMessagesForCompression(world, conversation, payload.startMessageId, payload.endMessageId);
  if (selected.length === 0) return;

  const first = world.get(selected[0], Message)!;
  const last = world.get(selected[selected.length - 1], Message)!;
  const now = Date.now();
  const contents = selected.map((entity) => world.get(entity, Message)?.content).filter((content): content is MessageContent => !!content);
  const sourceHash = hashText(JSON.stringify(contents));
  const tokenCountBefore = estimateContentsTokens(contents);

  const block = cmd.spawn();
  const blockId = `compression-block-${block}`;
  cmd.add(block, CompressionBlock, {
    id: blockId,
    conversation,
    title: payload.trigger === 'auto' ? '自动上下文压缩' : '上下文压缩',
    status: 'running',
    methodKind: payload.methodKind ?? 'llm_summary',
    ...(payload.methodConfigId ? { methodConfigId: payload.methodConfigId } : {}),
    anchorMessageId: last.id,
    anchorSeq: last.seq,
    startSeq: first.seq,
    endSeq: last.seq,
    sourceMessageCount: selected.length,
    tokenCountBefore,
    sourceHash,
    createdAt: now,
    updatedAt: now
  });

  selected.forEach((messageEntity, index) => {
    const message = world.get(messageEntity, Message)!;
    const revision = currentRevisionForMessage(world, messageEntity);
    const link = cmd.spawn();
    cmd.add(link, CompressionBlockSourceLink, {
      id: `compression-source-${link}`,
      block,
      source: messageEntity,
      sourceKind: 'message',
      sourceId: message.id,
      ...(revision ? { revisionId: revision.id } : {}),
      role: index === selected.length - 1 ? 'anchor' : 'source',
      order: index,
      createdAt: now,
      updatedAt: now
    });
  });

  cmd.effect({
    kind: 'llm.compact',
    request: {
      id: `compact-${blockId}`,
      blockId,
      conversationId: payload.conversationId,
      ...(payload.methodConfigId ? { methodConfigId: payload.methodConfigId } : {}),
      ...(payload.methodKind ? { methodKind: payload.methodKind } : {}),
      contents,
      sourceHash
    }
  });
}

function completeCompressionBlock(world: WorldReader, cmd: CommandSink, payload: LlmCompactDonePayload): void {
  const blockEntity = findBlock(world, payload.blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  if (blockEntity === undefined || !block) return;
  if (block.sourceHash && payload.result.methodConfig && payload.result.methodConfig.id === 'stale') return;
  const now = payload.completedAt;
  const methodKind = payload.result.methodConfig?.kind ?? block.methodKind;
  const tokenCountAfter = estimateContentsTokens(payload.result.contents);
  const summaryPreview = previewFromContents(payload.result.contents) || block.summaryPreview;
  cmd.add(blockEntity, CompressionBlock, {
    ...block,
    status: 'complete',
    methodKind,
    ...(payload.result.methodConfig?.id ? { methodConfigId: payload.result.methodConfig.id } : block.methodConfigId ? { methodConfigId: block.methodConfigId } : {}),
    ...(summaryPreview ? { summaryPreview } : {}),
    tokenCountAfter,
    tokenSaved: block.tokenCountBefore !== undefined ? Math.max(0, block.tokenCountBefore - tokenCountAfter) : undefined,
    updatedAt: now,
    completedAt: now
  });
  const nativeVariant = cmd.spawn();
  const isNative = methodKind === 'openai_responses_compact';
  cmd.add(nativeVariant, CompressionContextVariant, {
    id: `compression-variant-${nativeVariant}`,
    block: blockEntity,
    kind: isNative ? 'provider_native' : 'provider_neutral_summary',
    contents: payload.result.contents,
    compatibility: isNative ? { provider: 'openai-responses', format: 'openai-responses', endpoint: 'responses.compact' } : undefined,
    ...(payload.result.usageMetadata ? { usageMetadata: payload.result.usageMetadata } : {}),
    ...(payload.result.rawResponse !== undefined ? { rawResponse: payload.result.rawResponse } : {}),
    createdAt: now,
    updatedAt: now
  });

  if (isNative && !hasSummaryVariant(world, blockEntity)) {
    const sourceContents = sourceContentsForBlock(world, blockEntity);
    const summary = deterministicSummary(sourceContents);
    const summaryVariant = cmd.spawn();
    cmd.add(summaryVariant, CompressionContextVariant, {
      id: `compression-variant-${summaryVariant}`,
      block: blockEntity,
      kind: 'provider_neutral_summary',
      contents: [{ role: 'user', parts: [{ text: `[Context Summary]\n\n${summary}` }] }],
      createdAt: now,
      updatedAt: now
    });
  }
}

function failCompressionBlock(world: WorldReader, cmd: CommandSink, payload: LlmCompactErrorPayload): void {
  const blockEntity = findBlock(world, payload.blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  if (blockEntity === undefined || !block) return;
  cmd.add(blockEntity, CompressionBlock, { ...block, status: 'error', error: payload.message, updatedAt: payload.completedAt, completedAt: payload.completedAt });
}

function updateCompressionBlock(world: WorldReader, cmd: CommandSink, payload: { blockId: string; title?: string; summaryPreview?: string; summaryContents?: MessageContent[] }): void {
  const blockEntity = findBlock(world, payload.blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  if (blockEntity === undefined || !block) return;
  const now = Date.now();
  cmd.add(blockEntity, CompressionBlock, {
    ...block,
    ...(payload.title !== undefined ? { title: payload.title.trim() || block.title } : {}),
    ...(payload.summaryPreview !== undefined ? { summaryPreview: payload.summaryPreview } : {}),
    updatedAt: now
  });
  if (payload.summaryContents?.length) {
    const existing = world.query(CompressionContextVariant).find((entity) => {
      const variant = world.get(entity, CompressionContextVariant);
      return variant?.block === blockEntity && variant.kind === 'provider_neutral_summary';
    });
    if (existing !== undefined) {
      const variant = world.get(existing, CompressionContextVariant)!;
      cmd.add(existing, CompressionContextVariant, { ...variant, contents: payload.summaryContents, updatedAt: now });
    } else {
      const variant = cmd.spawn();
      cmd.add(variant, CompressionContextVariant, { id: `compression-variant-${variant}`, block: blockEntity, kind: 'provider_neutral_summary', contents: payload.summaryContents, createdAt: now, updatedAt: now });
    }
  }
}

function regenerateCompressionBlock(world: WorldReader, cmd: CommandSink, blockId: string, conversationId: string, methodConfigId?: string): void {
  const blockEntity = findBlock(world, blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  if (!block) return;
  const now = Date.now();
  cmd.add(blockEntity!, CompressionBlock, { ...block, status: 'stale', staleReason: '已重新生成新的压缩块。', updatedAt: now });
  cmd.enqueue({ type: CompressionEventType.Create, payload: { conversationId, endMessageId: block.anchorMessageId, ...(methodConfigId ? { methodConfigId } : block.methodConfigId ? { methodConfigId: block.methodConfigId } : {}), methodKind: block.methodKind, trigger: 'manual' } });
}

function setBlockDisabled(world: WorldReader, cmd: CommandSink, blockId: string, disabled: boolean): void {
  const blockEntity = findBlock(world, blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  if (blockEntity === undefined || !block) return;
  const now = Date.now();
  cmd.add(blockEntity, CompressionBlock, { ...block, status: disabled ? 'disabled' : 'complete', updatedAt: now });
}

function deleteCompressionBlock(world: WorldReader, cmd: CommandSink, blockId: string): void {
  const blockEntity = findBlock(world, blockId);
  if (blockEntity === undefined) return;
  const block = world.get(blockEntity, CompressionBlock);
  if (block?.status === 'pending' || block?.status === 'running') {
    cmd.effect({ kind: 'llm.abort', requestId: `compact-${block.id}` });
  }
  for (const entity of world.query(CompressionBlockSourceLink)) if (world.get(entity, CompressionBlockSourceLink)?.block === blockEntity) cmd.despawn(entity);
  for (const entity of world.query(CompressionContextVariant)) if (world.get(entity, CompressionContextVariant)?.block === blockEntity) cmd.despawn(entity);
  for (const entity of world.query(RunCompressionBlockLink)) if (world.get(entity, RunCompressionBlockLink)?.block === blockEntity) cmd.despawn(entity);
  cmd.despawn(blockEntity);
}

function selectMessagesForCompression(world: WorldReader, conversation: Entity, startMessageId?: string, endMessageId?: string): Entity[] {
  const allMessages = conversationMessages(world, conversation);
  if (allMessages.some((entity) => world.get(entity, Message)?.status === 'streaming')) return [];
  const messages = allMessages.filter((entity) => !containsOnlyProviderContext(world.get(entity, Message)?.content));
  const startIndex = startMessageId ? messages.findIndex((entity) => world.get(entity, Message)?.id === startMessageId) : 0;
  const endIndex = endMessageId ? messages.findIndex((entity) => world.get(entity, Message)?.id === endMessageId) : messages.length - 1;
  if (messages.length <= 1) return [];
  const from = Math.max(0, startIndex < 0 ? 0 : startIndex);
  const to = Math.max(from, endIndex < 0 ? messages.length - 1 : endIndex);
  return messages.slice(from, to + 1);
}

function containsOnlyProviderContext(content: MessageContent | undefined): boolean {
  return !!content && content.parts.length > 0 && content.parts.every(isProviderContextPart);
}

function currentRevisionForMessage(world: WorldReader, message: Entity): { id: string } | undefined {
  const link = world.query(MessageCurrentRevisionLink).map((entity) => world.get(entity, MessageCurrentRevisionLink)).find((candidate) => candidate?.message === message);
  return link ? world.get(link.revision, MessageRevision) : undefined;
}

function sourceContentsForBlock(world: WorldReader, block: Entity): MessageContent[] {
  return world.query(CompressionBlockSourceLink)
    .map((entity) => world.get(entity, CompressionBlockSourceLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.block === block && link.source !== undefined)
    .sort((left, right) => left.order - right.order)
    .map((link) => link.source !== undefined ? world.get(link.source, Message)?.content : undefined)
    .filter((content): content is MessageContent => !!content);
}

function hasSummaryVariant(world: WorldReader, block: Entity): boolean {
  return world.query(CompressionContextVariant).some((entity) => {
    const variant = world.get(entity, CompressionContextVariant);
    return variant?.block === block && variant.kind === 'provider_neutral_summary';
  });
}

function findConversation(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}

function findBlock(world: WorldReader, blockId: string): Entity | undefined {
  return world.query(CompressionBlock).find((entity) => world.get(entity, CompressionBlock)?.id === blockId);
}

function estimateContentsTokens(contents: MessageContent[]): number {
  const text = contents.flatMap((content) => content.parts.map(renderPart)).join('\n');
  const estimated = estimateTokenCount(text);
  return Number.isFinite(estimated) ? Math.max(0, estimated) : 0;
}

function previewFromContents(contents: MessageContent[]): string | undefined {
  const text = contents.flatMap((content) => content.parts.map(renderPart)).join(' ').replace(/\s+/g, ' ').trim();
  return text ? (text.length > 240 ? `${text.slice(0, 239)}…` : text) : undefined;
}

function deterministicSummary(contents: MessageContent[]): string {
  const rendered = contents.map((content, index) => `${index + 1}. ${content.role}: ${content.parts.map(renderPart).filter(Boolean).join('\n') || '[empty]'}`).join('\n\n');
  return rendered.length > 12_000 ? `${rendered.slice(0, 12_000)}\n\n[已截断]` : rendered;
}

function renderPart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[tool call] ${part.functionCall.name}: ${safeJson(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[tool result] ${part.functionResponse.name}: ${safeJson(part.functionResponse.response)}`;
  if (isInlineDataPart(part)) return `[inline data] ${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `[file] ${part.fileData.uri}`;
  if (isProviderContextPart(part)) return `[provider context] ${part.providerContext.format}:${part.providerContext.itemType ?? 'context'}`;
  return '';
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
