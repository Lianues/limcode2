import { estimateTokenCount } from 'tokenx';
import { defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { AgentRun } from '../../agentRun/components';
import { Conversation, Message, MessageCurrentRevisionLink, MessageRevision, PartOf } from '../../chat/components';
import { conversationMessages } from '../../chat/queries';
import { LlmEventType } from '../../llm/events';
import type { LlmCompactDonePayload, LlmCompactErrorPayload } from '../../llm/events';
import { LlmInvocation } from '../../llm/components';
import { CompressionBlock, CompressionBlockLlmInvocationLink, CompressionBlockSourceLink, CompressionContextVariant, RunCompressionBlockLink } from '../components';
import { CompressionEventType } from '../events';
import { ToolCall, ToolState } from '../../tools/components';
import type { CompressionBlockRecord, ContentPart, MessageContent, MessageRecord, ToolCallRecord } from '../../../../../shared/protocol';
import { isFileDataPart, isFunctionCallPart, isFunctionResponsePart, isInlineDataPart, isProviderContextPart, isTextPart, isVisibleTextPart } from '../../../../../shared/protocol';
import { buildTaskListTimeline, formatTaskListSnapshotForContext } from '../../../../../shared/taskListProjection';

const COMPRESSION_WRITE_COMPONENTS = [
  Conversation,
  Message,
  PartOf,
  MessageRevision,
  MessageCurrentRevisionLink,
  AgentRun,
  CompressionBlock,
  CompressionBlockSourceLink,
  CompressionContextVariant,
  RunCompressionBlockLink,
  LlmInvocation,
  CompressionBlockLlmInvocationLink
] as const;
const COMPRESSION_READ_COMPONENTS = [...COMPRESSION_WRITE_COMPONENTS, ToolCall, ToolState] as const;

export const CompressionSystem = defineSystem({
  name: 'CompressionSystem',
  access: {
    reads: { components: COMPRESSION_READ_COMPONENTS },
    writes: { components: COMPRESSION_WRITE_COMPONENTS, mutationMode: 'update' },
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

interface CompressionSelection {
  selected: Entity[];
  contents: MessageContent[];
  startSeq: number;
  anchor: { id: string; seq: number };
  segments?: MessageContent[][];
  priorSummaryContents?: MessageContent[];
}

function createCompressionBlock(
  world: WorldReader,
  cmd: CommandSink,
  payload: { conversationId: string; startMessageId?: string; endMessageId?: string; methodConfigId?: string; methodKind?: CompressionBlockRecord['methodKind']; trigger?: 'manual' | 'auto' }
): void {
  const conversation = findConversation(world, payload.conversationId);
  if (conversation === undefined) return;
  const methodKind = payload.methodKind ?? 'llm_summary';

  const selection = methodKind === 'segmented_summary'
    ? prepareSegmentedSelection(world, conversation, payload)
    : prepareFullSelection(world, conversation, payload);
  if (!selection) return;

  spawnCompressionBlock(world, cmd, conversation, methodKind, payload, selection);
}

function prepareFullSelection(
  world: WorldReader,
  conversation: Entity,
  payload: { startMessageId?: string; endMessageId?: string }
): CompressionSelection | undefined {
  const selected = selectMessagesForCompression(world, conversation, payload.startMessageId, payload.endMessageId);
  if (selected.length === 0) return undefined;
  const first = world.get(selected[0], Message)!;
  const last = world.get(selected[selected.length - 1], Message)!;
  const contents = selected.map((entity) => world.get(entity, Message)?.content).filter((content): content is MessageContent => !!content);
  return { selected, contents, startSeq: first.seq, anchor: { id: last.id, seq: last.seq } };
}

function spawnCompressionBlock(
  world: WorldReader,
  cmd: CommandSink,
  conversation: Entity,
  methodKind: CompressionBlockRecord['methodKind'],
  payload: { conversationId: string; methodConfigId?: string; trigger?: 'manual' | 'auto' },
  selection: CompressionSelection
): void {
  const { selected, contents, anchor } = selection;
  const now = Date.now();
  const sourceHash = hashText(JSON.stringify(contents));
  const tokenCountBefore = estimateContentsTokens(contents);

  const block = cmd.spawn();
  const blockId = `compression-block-${block}`;
  const compactRequestId = `compact-${blockId}`;
  cmd.add(block, CompressionBlock, {
    id: blockId,
    conversation,
    title: payload.trigger === 'auto' ? '自动上下文压缩' : '上下文压缩',
    status: 'running',
    methodKind,
    ...(payload.methodConfigId ? { methodConfigId: payload.methodConfigId } : {}),
    anchorMessageId: anchor.id,
    anchorSeq: anchor.seq,
    startSeq: selection.startSeq,
    endSeq: anchor.seq,
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

  const invocation = cmd.spawn();
  const invocationId = `llmi${invocation}`;
  cmd.add(invocation, LlmInvocation, {
    id: invocationId,
    requestId: compactRequestId,
    status: 'streaming',
    createdAt: now,
    startedAt: now
  });
  const invocationLink = cmd.spawn();
  cmd.add(invocationLink, CompressionBlockLlmInvocationLink, {
    id: `compression-invocation-${invocationLink}`,
    block,
    invocation,
    role: 'compact',
    createdAt: now,
    updatedAt: now
  });

  cmd.effect({
    kind: 'llm.compact',
    request: {
      id: compactRequestId,
      blockId,
      conversationId: payload.conversationId,
      invocationId,
      ...(payload.methodConfigId ? { methodConfigId: payload.methodConfigId } : {}),
      methodKind,
      contents,
      ...(selection.segments ? { segments: selection.segments } : {}),
      ...(selection.priorSummaryContents ? { priorSummaryContents: selection.priorSummaryContents } : {}),
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
  const taskListSnapshotText = taskListSnapshotTextForBoundary(world, block.conversation, block.endSeq ?? block.anchorSeq);
  const compactedContents = taskListSnapshotText ? appendTextToContents(payload.result.contents, taskListSnapshotText) : payload.result.contents;
  const tokenCountAfter = estimateContentsTokens(compactedContents);
  const summaryPreview = previewFromContents(compactedContents) || block.summaryPreview;
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
  completeCompressionInvocation(world, cmd, blockEntity, payload);
  const nativeVariant = cmd.spawn();
  const isNative = methodKind === 'openai_responses_compact';
  cmd.add(nativeVariant, CompressionContextVariant, {
    id: `compression-variant-${nativeVariant}`,
    block: blockEntity,
    kind: isNative ? 'provider_native' : 'provider_neutral_summary',
    contents: compactedContents,
    compatibility: isNative ? { provider: 'openai-responses', format: 'openai-responses', endpoint: 'responses.compact' } : undefined,
    ...(payload.result.usageMetadata ? { usageMetadata: payload.result.usageMetadata } : {}),
    ...(payload.result.rawResponse !== undefined ? { rawResponse: payload.result.rawResponse } : {}),
    createdAt: now,
    updatedAt: now
  });

  if (isNative && !hasSummaryVariant(world, blockEntity)) {
    const sourceContents = sourceContentsForBlock(world, blockEntity);
    const summary = deterministicSummary(sourceContents);
    const summaryContents: MessageContent[] = [{ role: 'user', parts: [{ text: `[Context Summary]\n\n${summary}` }] }];
    const summaryContentsWithTaskList = taskListSnapshotText ? appendTextToContents(summaryContents, taskListSnapshotText) : summaryContents;
    const summaryVariant = cmd.spawn();
    cmd.add(summaryVariant, CompressionContextVariant, {
      id: `compression-variant-${summaryVariant}`,
      block: blockEntity,
      kind: 'provider_neutral_summary',
      contents: summaryContentsWithTaskList,
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
  failCompressionInvocation(world, cmd, blockEntity, payload);
}

function completeCompressionInvocation(world: WorldReader, cmd: CommandSink, block: Entity, payload: LlmCompactDonePayload): void {
  const invocationEntity = compressionInvocationForBlock(world, block);
  const invocation = invocationEntity !== undefined ? world.get(invocationEntity, LlmInvocation) : undefined;
  if (invocationEntity === undefined || !invocation) return;
  const now = payload.completedAt;
  cmd.add(invocationEntity, LlmInvocation, {
    ...invocation,
    status: 'complete',
    ...(payload.result.settingsSnapshot ? { settings: payload.result.settingsSnapshot, resolvedAt: invocation.resolvedAt ?? invocation.startedAt ?? invocation.createdAt } : {}),
    ...(payload.result.usageMetadata ? { usageMetadata: payload.result.usageMetadata } : {}),
    completedAt: now
  });
}

function failCompressionInvocation(world: WorldReader, cmd: CommandSink, block: Entity, payload: LlmCompactErrorPayload): void {
  const invocationEntity = compressionInvocationForBlock(world, block);
  const invocation = invocationEntity !== undefined ? world.get(invocationEntity, LlmInvocation) : undefined;
  if (invocationEntity === undefined || !invocation) return;
  cmd.add(invocationEntity, LlmInvocation, {
    ...invocation,
    status: 'error',
    error: payload.message,
    completedAt: payload.completedAt
  });
}

function compressionInvocationForBlock(world: WorldReader, block: Entity): Entity | undefined {
  return world
    .query(CompressionBlockLlmInvocationLink)
    .map((entity) => world.get(entity, CompressionBlockLlmInvocationLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.block === block)
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0]?.invocation;
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
  for (const entity of world.query(CompressionBlockLlmInvocationLink)) {
    const link = world.get(entity, CompressionBlockLlmInvocationLink);
    if (link?.block !== blockEntity) continue;
    cmd.despawn(link.invocation);
    cmd.despawn(entity);
  }
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
  if (messages.length === 0) return [];
  const from = Math.max(0, startIndex < 0 ? 0 : startIndex);
  const to = Math.max(from, endIndex < 0 ? messages.length - 1 : endIndex);
  return messages.slice(from, to + 1);
}

function containsOnlyProviderContext(content: MessageContent | undefined): boolean {
  return !!content && content.parts.length > 0 && content.parts.every(isProviderContextPart);
}

/**
 * 分段总结的增量选择：
 * - 只取上一完成块边界之后、到 endBoundary 为止的消息；
 * - 按“回合”切分（正式回答闭合一个回合），只压缩已闭合回合；
 * - 末尾未闭合回合不纳入（靠 contextPolicy 以原文保留）；
 * - 若上一完成块存在其总结，作为“回合1前情”逐字传下去（不重新总结）。
 */
function prepareSegmentedSelection(
  world: WorldReader,
  conversation: Entity,
  payload: { endMessageId?: string }
): CompressionSelection | undefined {
  const allMessages = conversationMessages(world, conversation);
  if (allMessages.some((entity) => world.get(entity, Message)?.status === 'streaming')) return undefined;
  const messages = allMessages.filter((entity) => !containsOnlyProviderContext(world.get(entity, Message)?.content));
  if (messages.length === 0) return undefined;

  const endEntity = payload.endMessageId ? messages.find((entity) => world.get(entity, Message)?.id === payload.endMessageId) : undefined;
  const endBoundarySeq = endEntity
    ? world.get(endEntity, Message)!.seq
    : world.get(messages[messages.length - 1], Message)!.seq;

  const predecessor = latestCompleteBlockBelow(world, conversation, endBoundarySeq);
  const predecessorBlock = predecessor !== undefined ? world.get(predecessor, CompressionBlock) : undefined;
  const startBoundarySeq = predecessorBlock ? (predecessorBlock.endSeq ?? predecessorBlock.anchorSeq ?? 0) : -1;

  const increment = messages.filter((entity) => {
    const seq = world.get(entity, Message)?.seq ?? 0;
    return seq > startBoundarySeq && seq <= endBoundarySeq;
  });
  if (increment.length === 0) return undefined;

  const closedRounds = splitEntitiesIntoRounds(world, increment);
  if (closedRounds.length === 0) return undefined;

  const selected = closedRounds.flat();
  const contents = selected.map((entity) => world.get(entity, Message)?.content).filter((content): content is MessageContent => !!content);
  const segments = closedRounds.map((round) => round.map((entity) => world.get(entity, Message)?.content).filter((content): content is MessageContent => !!content));
  const firstSeq = world.get(selected[0], Message)!.seq;
  const lastMessage = world.get(selected[selected.length - 1], Message)!;
  const priorSummaryContents = predecessor !== undefined ? summaryVariantContents(world, predecessor) : undefined;

  return {
    selected,
    contents,
    startSeq: firstSeq,
    anchor: { id: lastMessage.id, seq: lastMessage.seq },
    segments,
    ...(priorSummaryContents ? { priorSummaryContents } : {})
  };
}

/**
 * 切分回合：一个回合 = 一段“用户诉求 → 模型干活 → 模型正式回答”的完整交互。
 * - 只有在当前回合“已闭合”(已出现过模型正式回答)之后，再遇到真实用户消息才切分开新回合；
 *   因此连续的多条用户消息(补充/追加/打断)会并入同一回合，而不会各自成为残缺回合。
 * - 模型正式回答(model + 可见文本 + 无工具调用)将当前回合标记为已闭合；模型工具调用会重置为未闭合
 *   (即便之前已回答过，正式回答后又调工具则视为继续干活)。因此中途的纯文本不会误判切断。
 * - 末尾回合只有已闭合时才纳入；进行中的末尾回合(如以工具调用结尾)整体丢弃，靠原文保留。
 */
function splitEntitiesIntoRounds(world: WorldReader, entities: Entity[]): Entity[][] {
  const rounds: Entity[][] = [];
  let current: Entity[] = [];
  let currentClosed = false;
  for (const entity of entities) {
    const content = world.get(entity, Message)?.content;
    if (currentClosed && isRealUserMessage(content) && current.length > 0) {
      rounds.push(current);
      current = [];
      currentClosed = false;
    }
    current.push(entity);
    if (content?.role === 'model') currentClosed = isFinalAnswer(content);
  }
  if (current.length > 0 && currentClosed) rounds.push(current);
  return rounds;
}

/** 真实用户消息：role=user 且不是工具结果(functionResponse)。工具结果虽然也是 user role，但属于回合内部。 */
function isRealUserMessage(content: MessageContent | undefined): boolean {
  if (!content || content.role !== 'user') return false;
  return !content.parts.some(isFunctionResponsePart);
}

/** 正式回答：model 消息含可见文本且无待处理工具调用。 */
function isFinalAnswer(content: MessageContent): boolean {
  return content.parts.some(isVisibleTextPart) && !content.parts.some(isFunctionCallPart);
}

/** 该会话中 anchorSeq 严格小于 upperSeq 的最新完成块（用于增量起点与前情来源；regenerate 时天然排除自身/更新块）。 */
function latestCompleteBlockBelow(world: WorldReader, conversation: Entity, upperSeq: number): Entity | undefined {
  return world.query(CompressionBlock)
    .filter((entity) => {
      const block = world.get(entity, CompressionBlock);
      if (!block || block.conversation !== conversation || block.status !== 'complete') return false;
      return (block.anchorSeq ?? block.endSeq ?? 0) < upperSeq;
    })
    .sort((left, right) => {
      const leftBlock = world.get(left, CompressionBlock)!;
      const rightBlock = world.get(right, CompressionBlock)!;
      return (rightBlock.anchorSeq ?? rightBlock.endSeq ?? 0) - (leftBlock.anchorSeq ?? leftBlock.endSeq ?? 0)
        || rightBlock.createdAt - leftBlock.createdAt
        || rightBlock.id.localeCompare(leftBlock.id);
    })[0];
}

function summaryVariantContents(world: WorldReader, block: Entity): MessageContent[] | undefined {
  const variant = world.query(CompressionContextVariant)
    .map((entity) => world.get(entity, CompressionContextVariant))
    .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate && candidate.block === block && candidate.kind === 'provider_neutral_summary')
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  return variant?.contents;
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

function taskListSnapshotTextForBoundary(world: WorldReader, conversation: Entity, boundarySeq: number | undefined): string | undefined {
  const conversationData = world.get(conversation, Conversation);
  if (!conversationData) return undefined;

  const messageEntities = conversationMessages(world, conversation)
    .filter((entity) => {
      const message = world.get(entity, Message);
      if (!message || message.status === 'streaming') return false;
      return boundarySeq === undefined || message.seq <= boundarySeq;
    });
  if (messageEntities.length === 0) return undefined;

  const messages = messageEntities
    .map((entity) => messageRecordForTaskListSnapshot(world, entity, conversationData.id))
    .filter((record): record is MessageRecord => record !== undefined);
  if (messages.length === 0) return undefined;

  const messageEntitySet = new Set(messageEntities);
  const toolCalls = world.query(ToolCall, ToolState, PartOf)
    .map((entity) => toolCallRecordForTaskListSnapshot(world, entity, messageEntitySet))
    .filter((record): record is ToolCallRecord => record !== undefined);
  if (toolCalls.length === 0) return undefined;

  const snapshot = buildTaskListTimeline({ messages, toolCalls, conversationId: conversationData.id }).snapshot;
  return snapshot.stats.total > 0 ? formatTaskListSnapshotForContext(snapshot) : undefined;
}

function messageRecordForTaskListSnapshot(world: WorldReader, entity: Entity, conversationId: string): MessageRecord | undefined {
  const message = world.get(entity, Message);
  if (!message) return undefined;
  return {
    id: message.id,
    conversationId,
    role: message.role,
    ...(message.model ? { model: message.model } : {}),
    content: message.content,
    status: message.status,
    createdAt: message.createdAt,
    ...(message.requestStartedAt !== undefined ? { requestStartedAt: message.requestStartedAt } : {}),
    ...(message.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: message.streamOutputDurationMs } : {}),
    ...(message.usageMetadata !== undefined ? { usageMetadata: message.usageMetadata } : {}),
    ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
    seq: message.seq
  };
}

function toolCallRecordForTaskListSnapshot(world: WorldReader, entity: Entity, messageEntities: ReadonlySet<Entity>): ToolCallRecord | undefined {
  const call = world.get(entity, ToolCall);
  const state = world.get(entity, ToolState);
  const messageEntity = world.get(entity, PartOf)?.parent;
  if (!call || !state || messageEntity === undefined || !messageEntities.has(messageEntity)) return undefined;
  const message = world.get(messageEntity, Message);
  if (!message) return undefined;
  return {
    id: call.id,
    messageId: message.id,
    name: call.name,
    ...(call.functionCallId ? { functionCallId: call.functionCallId } : {}),
    args: call.argsJson,
    status: state.status,
    ...(state.result !== undefined ? { result: state.result } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
    ...(state.progress !== undefined ? { progress: state.progress } : {}),
    ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
    createdAt: call.createdAt,
    updatedAt: state.updatedAt
  };
}

function appendTextToContents(contents: MessageContent[], text: string): MessageContent[] {
  const suffix = text.trim();
  if (!suffix) return contents;
  for (let contentIndex = contents.length - 1; contentIndex >= 0; contentIndex -= 1) {
    const content = contents[contentIndex];
    const partIndex = lastVisibleTextPartIndex(content.parts);
    if (partIndex < 0) continue;
    const part = content.parts[partIndex];
    if (!isTextPart(part)) continue;
    return contents.map((item, index) => index === contentIndex
      ? { ...item, parts: item.parts.map((candidate, candidateIndex) => candidateIndex === partIndex ? { ...part, text: `${part.text.trimEnd()}\n\n${suffix}` } : candidate) }
      : item);
  }
  return [...contents, { role: 'user', parts: [{ text: suffix }] }];
}

function lastVisibleTextPartIndex(parts: ContentPart[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (isTextPart(part) && part.thought !== true && part.text.trim()) return index;
  }
  return -1;
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
