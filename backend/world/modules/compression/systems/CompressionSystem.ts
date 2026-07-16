import { estimateTokenCount } from 'tokenx';
import { defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { AgentRun } from '../../agentRun/components';
import { Conversation, Message, MessageCurrentRevisionLink, MessageRevision, PartOf } from '../../chat/components';
import { conversationMessages } from '../../chat/queries';
import { LlmEventType } from '../../llm/events';
import type { LlmCompactDonePayload, LlmCompactErrorPayload, LlmRetryPayload } from '../../llm/events';
import { LlmInvocation } from '../../llm/components';
import { CompressionBlock, CompressionBlockLlmInvocationLink, CompressionBlockSourceLink, CompressionContextVariant, RunCompressionBlockLink, type CompressionBlockData } from '../components';
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
        LlmEventType.RetryScheduled,
        LlmEventType.RetryStarted,
        LlmEventType.RetryCancelled,
        LlmEventType.RetryRecovered,
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
    for (const payload of readEvents(ctx, LlmEventType.RetryScheduled) as LlmRetryPayload[]) updateCompressionRetryState(world, cmd, payload, 'scheduled');
    for (const payload of readEvents(ctx, LlmEventType.RetryStarted) as LlmRetryPayload[]) updateCompressionRetryState(world, cmd, payload, 'retrying');
    for (const payload of readEvents(ctx, LlmEventType.RetryCancelled) as LlmRetryPayload[]) updateCompressionRetryState(world, cmd, payload, 'cancelled');
    for (const payload of readEvents(ctx, LlmEventType.RetryRecovered) as LlmRetryPayload[]) updateCompressionRetryState(world, cmd, payload, 'recovered');
    for (const payload of readEvents(ctx, LlmEventType.CompactDone) as LlmCompactDonePayload[]) completeCompressionBlock(world, cmd, payload);
    for (const payload of readEvents(ctx, LlmEventType.CompactError) as LlmCompactErrorPayload[]) failCompressionBlock(world, cmd, payload);
  }
});

interface CompressionSelection {
  selected: Entity[];
  requestContents: MessageContent[];
  startSeq: number;
  sourceMessageCount: number;
  anchor: { id: string; seq: number };
  segments?: MessageContent[][];
  priorSummaryContents?: MessageContent[];
  retainedBlock?: Entity;
}

interface ReusableCompressionPredecessor {
  entity: Entity;
  block: CompressionBlockData;
  contents: MessageContent[];
}

function createCompressionBlock(
  world: WorldReader,
  cmd: CommandSink,
  payload: { conversationId: string; startMessageId?: string; endMessageId?: string; methodConfigId?: string; methodKind?: CompressionBlockRecord['methodKind']; trigger?: 'manual' | 'auto' }
): void {
  const conversation = findConversation(world, payload.conversationId);
  if (conversation === undefined) {
    debugAutoCompression('compression.create.skipConversationNotFound', { payload });
    return;
  }
  const methodKind = payload.methodKind ?? 'llm_summary';

  debugAutoCompression('compression.create.begin', {
    payload,
    conversation: describeConversation(world, conversation),
    methodKind,
    messages: describeConversationMessages(world, conversation)
  });

  const selection = methodKind === 'segmented_summary'
    ? prepareSegmentedSelection(world, conversation, payload)
    : prepareFullSelection(world, conversation, payload, methodKind);
  if (!selection) {
    debugAutoCompression('compression.create.skipNoSelection', {
      payload,
      conversation: describeConversation(world, conversation),
      methodKind
    });
    return;
  }

  debugAutoCompression('compression.create.selection', {
    payload,
    methodKind,
    selected: selection.selected.map((entity) => describeMessageEntity(world, entity)),
    requestContents: selection.requestContents.map(describeContent),
    startSeq: selection.startSeq,
    sourceMessageCount: selection.sourceMessageCount,
    anchor: selection.anchor,
    segmentCount: selection.segments?.length,
    segments: selection.segments?.map((segment) => segment.map(describeContent)),
    priorSummaryCount: selection.priorSummaryContents?.length,
    retainedBlock: selection.retainedBlock !== undefined ? world.get(selection.retainedBlock, CompressionBlock)?.id : undefined
  });

  spawnCompressionBlock(world, cmd, conversation, methodKind, payload, selection);
}

function prepareFullSelection(
  world: WorldReader,
  conversation: Entity,
  payload: { startMessageId?: string; endMessageId?: string },
  methodKind: CompressionBlockRecord['methodKind']
): CompressionSelection | undefined {
  const selected = selectMessagesForCompression(world, conversation, payload.startMessageId, payload.endMessageId);
  const direct = directCompressionSelection(world, selected);
  if (!direct) return undefined;
  if (payload.startMessageId) return direct;

  const predecessor = latestReusableBlockBelow(world, conversation, direct.anchor.seq, methodKind);
  if (predecessor === undefined) return direct;
  const predecessorBlock = predecessor.block;
  const retainedContents = predecessor.contents;

  const predecessorBoundary = predecessorBlock.endSeq ?? predecessorBlock.anchorSeq ?? 0;
  const increment = selected.filter((entity) => (world.get(entity, Message)?.seq ?? 0) > predecessorBoundary);
  if (increment.length === 0) {
    debugAutoCompression('compression.selection.skipNoIncrementAfterReusableBlock', {
      predecessorBlockId: predecessorBlock.id,
      predecessorBoundary,
      anchorSeq: direct.anchor.seq,
      selectedCount: selected.length
    });
    return undefined;
  }
  if (hasUnresolvedFunctionCallsInEntities(world, increment)) {
    debugAutoCompression('compression.selection.skipIncrementUnresolvedFunctionCalls', {
      predecessorBlockId: predecessorBlock.id,
      predecessorBoundary,
      increment: increment.map((entity) => describeMessageEntity(world, entity))
    });
    return undefined;
  }

  const first = world.get(increment[0], Message)!;
  const last = world.get(increment[increment.length - 1], Message)!;
  const incrementContents = messageContentsForEntities(world, increment);
  if (incrementContents.length === 0) {
    debugAutoCompression('compression.selection.skipNoIncrementContents', {
      predecessorBlockId: predecessorBlock.id,
      predecessorBoundary,
      increment: increment.map((entity) => describeMessageEntity(world, entity))
    });
    return undefined;
  }

  return {
    selected: increment,
    requestContents: [...retainedContents, ...incrementContents],
    startSeq: predecessorBlock.startSeq ?? first.seq,
    sourceMessageCount: Math.max(0, predecessorBlock.sourceMessageCount ?? 0) + increment.length,
    anchor: { id: last.id, seq: last.seq },
    retainedBlock: predecessor.entity
  };
}

function directCompressionSelection(world: WorldReader, selected: Entity[]): CompressionSelection | undefined {
  if (selected.length === 0) {
    debugAutoCompression('compression.selection.skipEmptySelection', {});
    return undefined;
  }
  if (hasUnresolvedFunctionCallsInEntities(world, selected)) {
    debugAutoCompression('compression.selection.skipUnresolvedFunctionCalls', {
      selected: selected.map((entity) => describeMessageEntity(world, entity))
    });
    return undefined;
  }
  const first = world.get(selected[0], Message)!;
  const last = world.get(selected[selected.length - 1], Message)!;
  const requestContents = messageContentsForEntities(world, selected);
  return {
    selected,
    requestContents,
    startSeq: first.seq,
    sourceMessageCount: selected.length,
    anchor: { id: last.id, seq: last.seq }
  };
}

function spawnCompressionBlock(
  world: WorldReader,
  cmd: CommandSink,
  conversation: Entity,
  methodKind: CompressionBlockRecord['methodKind'],
  payload: { conversationId: string; methodConfigId?: string; trigger?: 'manual' | 'auto' },
  selection: CompressionSelection
): void {
  const { selected, requestContents, anchor } = selection;
  const now = Date.now();
  const sourceHash = hashText(JSON.stringify(requestContents));
  const tokenCountBefore = estimateContentsTokens(requestContents);

  const block = cmd.spawn();
  const blockId = `compression-block-${block}`;
  const compactRequestId = `compact-${blockId}`;
  debugAutoCompression('compression.spawnBlock', {
    blockId,
    compactRequestId,
    conversationId: payload.conversationId,
    methodKind,
    trigger: payload.trigger,
    anchor,
    startSeq: selection.startSeq,
    endSeq: anchor.seq,
    selected: selected.map((entity) => describeMessageEntity(world, entity)),
    tokenCountBefore
  });

  cmd.add(block, CompressionBlock, {
    id: blockId,
    conversation,
    title: payload.trigger === 'auto' ? '自动上下文压缩' : '上下文压缩',
    status: 'running',
    ...(payload.trigger ? { trigger: payload.trigger } : {}),
    methodKind,
    ...(payload.methodConfigId ? { methodConfigId: payload.methodConfigId } : {}),
    anchorMessageId: anchor.id,
    anchorSeq: anchor.seq,
    startSeq: selection.startSeq,
    endSeq: anchor.seq,
    sourceMessageCount: selection.sourceMessageCount,
    tokenCountBefore,
    sourceHash,
    createdAt: now,
    updatedAt: now
  });

  let orderOffset = 0;
  if (selection.retainedBlock !== undefined) {
    const retained = world.get(selection.retainedBlock, CompressionBlock);
    if (retained) {
      const retainedLink = cmd.spawn();
      cmd.add(retainedLink, CompressionBlockSourceLink, {
        id: `compression-source-${retainedLink}`,
        block,
        source: selection.retainedBlock,
        sourceKind: 'compressionBlock',
        sourceId: retained.id,
        role: 'retained',
        order: 0,
        createdAt: now,
        updatedAt: now
      });
      orderOffset = 1;
    }
  }

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
      order: index + orderOffset,
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
      contents: requestContents,
      ...(selection.segments ? { segments: selection.segments } : {}),
      ...(selection.priorSummaryContents ? { priorSummaryContents: selection.priorSummaryContents } : {}),
      sourceHash
    }
  });
}
function updateCompressionRetryState(
  world: WorldReader,
  cmd: CommandSink,
  payload: LlmRetryPayload,
  retryStatus: 'scheduled' | 'retrying' | 'cancelled' | 'recovered'
): void {
  const target = compressionInvocationByRequestId(world, payload.requestId);
  if (!target) return;
  const invocation = world.get(target.invocation, LlmInvocation);
  if (!invocation) return;
  const now = payload.createdAt ?? Date.now();
  cmd.add(target.invocation, LlmInvocation, {
    ...invocation,
    status: invocation.status === 'complete' || invocation.status === 'error' || invocation.status === 'cancelled' ? invocation.status : 'streaming',
    retryStatus,
    retryAttempt: payload.retryAttempt,
    retryMaxAttempts: payload.retryMaxAttempts,
    retryDelayMs: retryStatus === 'scheduled' ? payload.retryDelayMs : undefined,
    retryMessage: payload.message,
    ...(payload.rawError ? { retryRawError: payload.rawError } : invocation.retryRawError ? { retryRawError: invocation.retryRawError } : {}),
    retryUpdatedAt: now
  });

  const block = world.get(target.block, CompressionBlock);
  if (block && (retryStatus === 'scheduled' || retryStatus === 'retrying')) {
    cmd.add(target.block, CompressionBlock, { ...block, status: 'running', updatedAt: now });
  }
}

function compressionInvocationByRequestId(world: WorldReader, requestId: string): { invocation: Entity; block: Entity } | undefined {
  const invocation = world.query(LlmInvocation).find((entity) => world.get(entity, LlmInvocation)?.requestId === requestId);
  if (invocation === undefined) return undefined;
  const link = world
    .query(CompressionBlockLlmInvocationLink)
    .map((entity) => world.get(entity, CompressionBlockLlmInvocationLink))
    .find((candidate): candidate is NonNullable<typeof candidate> => !!candidate && candidate.invocation === invocation);
  return link ? { invocation, block: link.block } : undefined;
}



function completeCompressionBlock(world: WorldReader, cmd: CommandSink, payload: LlmCompactDonePayload): void {
  const blockEntity = findBlock(world, payload.blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  debugAutoCompression('compression.complete.event', {
    requestId: payload.requestId,
    blockId: payload.blockId,
    conversationId: payload.conversationId,
    found: blockEntity !== undefined && !!block,
    currentStatus: block?.status,
    resultContentCount: payload.result.contents.length,
    resultMethodKind: payload.result.methodConfig?.kind
  });
  if (blockEntity === undefined || !block) return;
  if (block.sourceHash && payload.result.methodConfig && payload.result.methodConfig.id === 'stale') {
    debugAutoCompression('compression.complete.skipStaleResult', { requestId: payload.requestId, blockId: payload.blockId });
    return;
  }
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

  debugAutoCompression('compression.complete.apply', {
    requestId: payload.requestId,
    blockId: payload.blockId,
    previousStatus: block.status,
    nextStatus: 'complete',
    tokenCountAfter,
    tokenSaved: block.tokenCountBefore !== undefined ? Math.max(0, block.tokenCountBefore - tokenCountAfter) : undefined
  });
}

function failCompressionBlock(world: WorldReader, cmd: CommandSink, payload: LlmCompactErrorPayload): void {
  const blockEntity = findBlock(world, payload.blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  debugAutoCompression('compression.fail.event', {
    requestId: payload.requestId,
    blockId: payload.blockId,
    conversationId: payload.conversationId,
    found: blockEntity !== undefined && !!block,
    currentStatus: block?.status,
    message: payload.message
  });
  if (blockEntity === undefined || !block) return;
  cmd.add(blockEntity, CompressionBlock, { ...block, status: 'error', error: payload.message, updatedAt: payload.completedAt, completedAt: payload.completedAt });
  failCompressionInvocation(world, cmd, blockEntity, payload);
  debugAutoCompression('compression.fail.apply', {
    requestId: payload.requestId,
    blockId: payload.blockId,
    previousStatus: block.status,
    nextStatus: 'error',
    message: payload.message
  });
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
  const retryStatus = invocation.retryStatus === 'cancelled'
    ? 'cancelled'
    : payload.retryAttempt !== undefined && payload.retryAttempt > 0 ? 'exhausted' : invocation.retryStatus;
  cmd.add(invocationEntity, LlmInvocation, {
    ...invocation,
    status: 'error',
    error: payload.message,
    ...(retryStatus ? { retryStatus } : {}),
    ...(payload.retryAttempt !== undefined ? { retryAttempt: payload.retryAttempt } : {}),
    ...(payload.retryMaxAttempts !== undefined ? { retryMaxAttempts: payload.retryMaxAttempts } : {}),
    retryDelayMs: undefined,
    retryMessage: payload.message,
    ...(payload.rawError ? { retryRawError: payload.rawError } : {}),
    retryUpdatedAt: payload.completedAt,
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
  const messages = allMessages.filter((entity) => !containsOnlyProviderContext(world.get(entity, Message)?.content));
  const startIndex = startMessageId ? messages.findIndex((entity) => world.get(entity, Message)?.id === startMessageId) : 0;
  const endIndex = endMessageId ? messages.findIndex((entity) => world.get(entity, Message)?.id === endMessageId) : messages.length - 1;
  if (messages.length === 0) return [];
  const from = Math.max(0, startIndex < 0 ? 0 : startIndex);
  const to = Math.max(from, endIndex < 0 ? messages.length - 1 : endIndex);
  const selected = messages.slice(from, to + 1);
  const streamingSelected = selected.filter((entity) => world.get(entity, Message)?.status === 'streaming');
  if (streamingSelected.length > 0) {
    debugAutoCompression('compression.select.skipStreaming', { conversation: describeConversation(world, conversation), messages: streamingSelected.map((entity) => describeMessageEntity(world, entity)) });
    return [];
  }
  debugAutoCompression('compression.select.full', {
    conversation: describeConversation(world, conversation),
    startMessageId,
    endMessageId,
    startIndex,
    endIndex,
    from,
    to,
    selected: selected.map((entity) => describeMessageEntity(world, entity))
  });
  return selected;
}

function containsOnlyProviderContext(content: MessageContent | undefined): boolean {
  return !!content && content.parts.length > 0 && content.parts.every(isProviderContextPart);
}

/**
 * 分段总结的增量选择：
 * - 只取上一完成块边界之后、到 endBoundary 为止的消息；
 * - 按“回合”切分，正式回答或已落地的工具响应都可闭合当前触发边界；
 * - 末尾未闭合回合不纳入（靠 contextPolicy 以原文保留）；
 * - 若上一完成块存在其总结，作为“回合1前情”逐字传下去（不重新总结）。
 */
function prepareSegmentedSelection(
  world: WorldReader,
  conversation: Entity,
  payload: { endMessageId?: string }
): CompressionSelection | undefined {
  const allMessages = conversationMessages(world, conversation);
  const messages = allMessages.filter((entity) => !containsOnlyProviderContext(world.get(entity, Message)?.content));
  if (messages.length === 0) return undefined;

  const endEntity = payload.endMessageId ? messages.find((entity) => world.get(entity, Message)?.id === payload.endMessageId) : undefined;
  const endBoundarySeq = endEntity
    ? world.get(endEntity, Message)!.seq
    : world.get(messages[messages.length - 1], Message)!.seq;
  const streamingInRange = messages.some((entity) => {
    const message = world.get(entity, Message);
    return !!message && message.status === 'streaming' && message.seq <= endBoundarySeq;
  });
  if (streamingInRange) {
    debugAutoCompression('compression.segmented.skipStreamingInRange', {
      payload,
      endBoundarySeq,
      streamingMessages: messages
        .filter((entity) => {
          const message = world.get(entity, Message);
          return !!message && message.status === 'streaming' && message.seq <= endBoundarySeq;
        })
        .map((entity) => describeMessageEntity(world, entity))
    });
    return undefined;
  }

  const predecessor = latestReusableBlockBelow(world, conversation, endBoundarySeq, 'segmented_summary');
  const predecessorBlock = predecessor?.block;
  const startBoundarySeq = predecessorBlock ? (predecessorBlock.endSeq ?? predecessorBlock.anchorSeq ?? 0) : -1;

  const increment = messages.filter((entity) => {
    const seq = world.get(entity, Message)?.seq ?? 0;
    return seq > startBoundarySeq && seq <= endBoundarySeq;
  });
  if (increment.length === 0) {
    debugAutoCompression('compression.segmented.skipNoIncrementAfterReusableBlock', {
      payload,
      endBoundarySeq,
      startBoundarySeq,
      predecessorBlockId: predecessorBlock?.id
    });
    return undefined;
  }

  const closedRounds = splitEntitiesIntoRounds(world, increment);
  debugAutoCompression('compression.segmented.rounds', {
    payload,
    conversation: describeConversation(world, conversation),
    endBoundarySeq,
    startBoundarySeq,
    increment: increment.map((entity) => describeMessageEntity(world, entity)),
    closedRounds: closedRounds.map((round) => round.map((entity) => describeMessageEntity(world, entity)))
  });
  if (closedRounds.length === 0) {
    debugAutoCompression('compression.segmented.skipNoClosedRounds', {
      payload,
      endBoundarySeq,
      startBoundarySeq,
      increment: increment.map((entity) => describeMessageEntity(world, entity))
    });
    return undefined;
  }

  const selected = closedRounds.flat();
  if (hasUnresolvedFunctionCallsInEntities(world, selected)) {
    debugAutoCompression('compression.segmented.skipUnresolvedFunctionCalls', {
      payload,
      selected: selected.map((entity) => describeMessageEntity(world, entity))
    });
    return undefined;
  }

  const requestContents = predecessor !== undefined
    ? [...predecessor.contents, ...messageContentsForEntities(world, selected)]
    : messageContentsForEntities(world, selected);
  const segments = closedRounds.map((round) => round.map((entity) => world.get(entity, Message)?.content).filter((content): content is MessageContent => !!content));
  const firstSeq = world.get(selected[0], Message)!.seq;
  const lastMessage = world.get(selected[selected.length - 1], Message)!;
  const priorSummaryContents = predecessor?.contents;

  return {
    selected,
    requestContents,
    startSeq: predecessorBlock?.startSeq ?? firstSeq,
    sourceMessageCount: Math.max(0, predecessorBlock?.sourceMessageCount ?? 0) + selected.length,
    anchor: { id: lastMessage.id, seq: lastMessage.seq },
    segments,
    ...(priorSummaryContents ? { priorSummaryContents } : {}),
    ...(predecessor !== undefined ? { retainedBlock: predecessor.entity } : {})
  };
}

/**
 * 切分回合：一个回合 = 一段“用户诉求 → 模型干活 → 模型正式回答”的完整交互。
 * - 只有在当前回合“已闭合”(已出现过模型正式回答)之后，再遇到真实用户消息才切分开新回合；
 *   因此连续的多条用户消息(补充/追加/打断)会并入同一回合，而不会各自成为残缺回合。
 * - 模型正式回答(model + 可见文本 + 无工具调用)将当前回合标记为已闭合；模型工具调用会重置为未闭合
 *   (即便之前已回答过，正式回答后又调工具则视为继续干活)。
 * - 工具响应消息属于回合内部；当自动压缩锚定在工具响应后时，工具响应也闭合一个可总结边界，
 *   这样不会把“工具调用 → 工具结果”拆开或把压缩块插到工具结果前面。
 * - 末尾回合只有已闭合时才纳入；进行中的末尾回合整体丢弃，靠 contextPolicy 以原文保留。
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
    else if (isToolResponseMessage(content)) currentClosed = true;
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

function isToolResponseMessage(content: MessageContent | undefined): boolean {
  return !!content && content.role === 'user' && content.parts.some(isFunctionResponsePart);
}

/** 该会话中 anchorSeq 严格小于 upperSeq 的完成块，按新到旧排序（用于增量起点与前情来源；regenerate 时天然排除自身/更新块）。 */
function completeBlocksBelow(world: WorldReader, conversation: Entity, upperSeq: number): Entity[] {
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
    });
}

function latestReusableBlockBelow(
  world: WorldReader,
  conversation: Entity,
  upperSeq: number,
  methodKind: CompressionBlockRecord['methodKind']
): ReusableCompressionPredecessor | undefined {
  for (const entity of completeBlocksBelow(world, conversation, upperSeq)) {
    const block = world.get(entity, CompressionBlock);
    if (!block) continue;
    const compatibility = compressionBlockReuseCompatibility(block, methodKind);
    if (!compatibility) continue;
    const contents = reusableVariantContents(world, entity, methodKind);
    if (contents?.length) return { entity, block, contents };
  }
  return undefined;
}

function reusableVariantContents(world: WorldReader, block: Entity, methodKind: CompressionBlockRecord['methodKind']): MessageContent[] | undefined {
  const variants = world.query(CompressionContextVariant)
    .map((entity) => world.get(entity, CompressionContextVariant))
    .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate && candidate.block === block);
  const sorted = variants.sort((left, right) => right.createdAt - left.createdAt);
  const nativeVariant = methodKind === 'openai_responses_compact'
    ? sorted.find((candidate) => candidate.kind === 'provider_native')
    : undefined;
  const summaryVariant = sorted
    .filter((candidate) => candidate.kind === 'provider_neutral_summary')
    [0];
  const variant = nativeVariant ?? summaryVariant;
  return variant?.contents;
}

function compressionBlockReuseCompatibility(
  block: CompressionBlockData,
  currentMethodKind: CompressionBlockRecord['methodKind']
): boolean {
  return block.methodKind !== 'openai_responses_compact' || currentMethodKind === 'openai_responses_compact';
}

function currentRevisionForMessage(world: WorldReader, message: Entity): { id: string } | undefined {
  const link = world.query(MessageCurrentRevisionLink).map((entity) => world.get(entity, MessageCurrentRevisionLink)).find((candidate) => candidate?.message === message);
  return link ? world.get(link.revision, MessageRevision) : undefined;
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

function messageContentsForEntities(world: WorldReader, entities: Entity[]): MessageContent[] {
  return entities
    .map((entity) => world.get(entity, Message)?.content)
    .filter((content): content is MessageContent => !!content);
}

function hasUnresolvedFunctionCallsInEntities(world: WorldReader, entities: Entity[]): boolean {
  const pendingCallIds = new Set<string>();
  const pendingCallNames = new Map<string, number>();
  for (const entity of entities) {
    const content = world.get(entity, Message)?.content;
    if (!content) continue;
    for (const part of content.parts) {
      if (isFunctionCallPart(part)) {
        const callId = part.id?.trim();
        if (callId) {
          pendingCallIds.add(callId);
        } else {
          pendingCallNames.set(part.functionCall.name, (pendingCallNames.get(part.functionCall.name) ?? 0) + 1);
        }
        continue;
      }
      if (!isFunctionResponsePart(part)) continue;
      const callId = part.id?.trim();
      if (callId) {
        pendingCallIds.delete(callId);
      } else {
        const nextCount = (pendingCallNames.get(part.functionResponse.name) ?? 0) - 1;
        if (nextCount > 0) pendingCallNames.set(part.functionResponse.name, nextCount);
        else pendingCallNames.delete(part.functionResponse.name);
      }
    }
  }
  return pendingCallIds.size > 0 || pendingCallNames.size > 0;
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

function debugAutoCompression(stage: string, payload: Record<string, unknown>): void {
  const log = /skip|fail|error/i.test(stage) ? console.warn : console.info;
  log('[LimCode][Compression][System]', stage, sanitizeDebugValue(payload));
}

function sanitizeDebugValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const maxItems = 30;
    const items = value.slice(0, maxItems).map((item) => sanitizeDebugValue(item, depth + 1));
    return value.length > maxItems ? [...items, { omittedItems: value.length - maxItems }] : items;
  }
  if (depth >= 4) return '[Object]';
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = sanitizeDebugValue(item, depth + 1);
  }
  return result;
}

function describeConversation(world: WorldReader, conversation: Entity): Record<string, unknown> | undefined {
  const data = world.get(conversation, Conversation);
  return data ? { entity: conversation, id: data.id, title: data.title } : undefined;
}

function describeConversationMessages(world: WorldReader, conversation: Entity): Array<Record<string, unknown> | undefined> {
  return conversationMessages(world, conversation).map((entity) => describeMessageEntity(world, entity));
}

function describeMessageEntity(world: WorldReader, entity: Entity): Record<string, unknown> | undefined {
  const message = world.get(entity, Message);
  return message ? describeMessageData(message) : undefined;
}

function describeMessageData(message: MessageDataLike): Record<string, unknown> {
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    status: message.status,
    partKinds: message.content.parts.map(describePartKind),
    visibleTextLength: message.content.parts
      .filter(isVisibleTextPart)
      .reduce((total, part) => total + ('text' in part ? part.text.length : 0), 0)
  };
}

interface MessageDataLike {
  id: string;
  seq: number;
  role: string;
  status: string;
  content: MessageContent;
}

function describeContent(content: MessageContent): Record<string, unknown> {
  return {
    role: content.role,
    partKinds: content.parts.map(describePartKind),
    visibleTextLength: content.parts
      .filter(isVisibleTextPart)
      .reduce((total, part) => total + ('text' in part ? part.text.length : 0), 0)
  };
}

function describePartKind(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? 'thoughtText' : 'text';
  if (isFunctionCallPart(part)) return `functionCall:${part.functionCall.name}`;
  if (isFunctionResponsePart(part)) return `functionResponse:${part.functionResponse.name}`;
  if (isProviderContextPart(part)) return `providerContext:${part.providerContext.itemType ?? part.providerContext.format}`;
  if (isInlineDataPart(part)) return `inlineData:${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `fileData:${part.fileData.mimeType ?? 'unknown'}`;
  return Object.keys(part)[0] ?? 'unknown';
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
