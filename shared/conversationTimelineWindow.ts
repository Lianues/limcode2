import { createEmptyClientState } from './clientStateSchema';
import type { ClientState, ConversationTimelineChunkSummaryRecord, MessageRecord } from './protocol';

export const CONVERSATION_STREAM_RECENT_MESSAGE_LIMIT = 240;

export interface ConversationTimelineSeqRange {
  startSeq: number;
  endSeq: number;
}

export interface ConversationTimelineSeqWindow {
  ranges: ConversationTimelineSeqRange[];
  tailAttached: boolean;
  tailStartSeq?: number;
}

export interface ConversationStreamMessageRemovalClassification {
  evictedMessageIds: Set<string>;
  semanticMessageIds: Set<string>;
}

/**
 * 由已加载 chunk 构造展示窗口。chunk 可以非连续；实时尾部是独立附着关系，
 * 不能再通过 pageInfo.hasNewer 反向推断。
 */
export function createConversationTimelineSeqWindow(
  chunks: readonly ConversationTimelineChunkSummaryRecord[],
  tailAttached: boolean
): ConversationTimelineSeqWindow | undefined {
  if (chunks.length === 0) return undefined;
  const ranges = [...chunks]
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
    .map((chunk) => ({ startSeq: chunk.startSeq, endSeq: chunk.endSeq }));
  const tailStartSeq = Math.max(...ranges.map((range) => range.endSeq));
  return {
    ranges,
    tailAttached,
    ...(tailAttached ? { tailStartSeq } : {})
  };
}

export function seqInConversationTimelineWindow(seq: number, window: ConversationTimelineSeqWindow): boolean {
  if (window.ranges.some((range) => seq >= range.startSeq && seq <= range.endSeq)) return true;
  return window.tailAttached && window.tailStartSeq !== undefined && seq > window.tailStartSeq;
}

export function timelineHasOlderChunks(chunks: readonly ConversationTimelineChunkSummaryRecord[]): boolean {
  const oldest = [...chunks].sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))[0];
  return !!oldest && oldest.index > 0;
}

export function timelineHasNewerChunks(
  chunks: readonly ConversationTimelineChunkSummaryRecord[],
  totalChunks: number
): boolean {
  if (totalChunks <= 0) return false;
  const newest = [...chunks].sort((left, right) => right.index - left.index || right.id.localeCompare(left.id))[0];
  return !newest || newest.index < totalChunks - 1;
}

/**
 * conversation stream 是固定长度的最近消息窗口。窗口向前滑动时产生的 remove
 * 只是投影淘汰，不是领域删除；其它 remove 才能传播到 page-owned 数据。
 */
export function conversationTimelineStateForMessageIds(
  state: ClientState,
  selectedMessageIds: ReadonlySet<string>
): ClientState {
  const result = createEmptyClientState();
  if (selectedMessageIds.size === 0) return result;

  result.messages = state.messages.filter((message) => selectedMessageIds.has(message.id));
  const messageIds = new Set(result.messages.map((message) => message.id));
  result.messageRevisions = state.messageRevisions.filter((revision) => messageIds.has(revision.messageId));
  const revisionIds = new Set(result.messageRevisions.map((revision) => revision.id));
  result.messageCurrentRevisionLinks = state.messageCurrentRevisionLinks.filter((link) =>
    messageIds.has(link.messageId) || revisionIds.has(link.revisionId)
  );

  result.toolCalls = state.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
  const toolCallIds = new Set(result.toolCalls.map((toolCall) => toolCall.id));
  result.toolCallEvents = state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId));
  result.messageRunLinks = state.messageRunLinks.filter((link) => messageIds.has(link.messageId));
  result.toolCallRunLinks = state.toolCallRunLinks.filter((link) => toolCallIds.has(link.toolCallId));
  const runIds = new Set([
    ...result.messageRunLinks.map((link) => link.runId),
    ...result.toolCallRunLinks.map((link) => link.runId)
  ]);
  result.agentRuns = state.agentRuns.filter((run) => runIds.has(run.id));
  result.agentRunSourceLinks = state.agentRunSourceLinks.filter((link) => runIds.has(link.runId));
  result.agentRunTargetLinks = state.agentRunTargetLinks.filter((link) => runIds.has(link.runId));
  result.agentRunQueueOrders = state.agentRunQueueOrders.filter((record) => runIds.has(record.runId));
  result.agentRunQueueHolds = state.agentRunQueueHolds.filter((record) => runIds.has(record.runId));
  result.agentRunQueuedInputs = state.agentRunQueuedInputs.filter((record) => runIds.has(record.runId));
  result.runWorkflowLinks = state.runWorkflowLinks.filter((link) => runIds.has(link.runId));
  result.runSystemPromptLinks = state.runSystemPromptLinks.filter((link) => runIds.has(link.runId));
  result.runModelProfileLinks = state.runModelProfileLinks.filter((link) => runIds.has(link.runId));
  result.runToolPolicyLinks = state.runToolPolicyLinks.filter((link) => runIds.has(link.runId));
  result.runConversationPolicyLinks = state.runConversationPolicyLinks.filter((link) => runIds.has(link.runId));
  result.runContextPolicyLinks = state.runContextPolicyLinks.filter((link) => runIds.has(link.runId));
  result.runDeliveryPolicyLinks = state.runDeliveryPolicyLinks.filter((link) => runIds.has(link.runId));
  result.runEditPolicyLinks = state.runEditPolicyLinks.filter((link) => runIds.has(link.runId));
  result.runRuntimeContextSnapshotLinks = state.runRuntimeContextSnapshotLinks.filter((link) => runIds.has(link.runId));
  result.runWorkEnvironmentLinks = state.runWorkEnvironmentLinks.filter((link) => runIds.has(link.runId));
  result.agentRunInputRevisions = state.agentRunInputRevisions.filter((record) => runIds.has(record.runId));
  result.runCompressionBlockLinks = state.runCompressionBlockLinks.filter((link) => runIds.has(link.runId));
  result.runPlanProposalLinks = state.runPlanProposalLinks.filter((link) => runIds.has(link.runId));

  result.messageLlmInvocationLinks = state.messageLlmInvocationLinks.filter((link) => messageIds.has(link.messageId));
  result.runLlmInvocationLinks = state.runLlmInvocationLinks.filter((link) => runIds.has(link.runId));
  const invocationIds = new Set([
    ...result.messageLlmInvocationLinks.map((link) => link.invocationId),
    ...result.runLlmInvocationLinks.map((link) => link.invocationId)
  ]);
  result.llmInvocations = state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id));

  result.checkpointTimelineAnchors = state.checkpointTimelineAnchors.filter((anchor) => messageIds.has(anchor.floorMessageId));
  const checkpointIds = new Set(result.checkpointTimelineAnchors.map((anchor) => anchor.checkpointId));
  result.checkpoints = state.checkpoints.filter((checkpoint) => checkpointIds.has(checkpoint.id));
  const projectContextIds = new Set(result.checkpoints.map((checkpoint) => checkpoint.projectContextId));
  const shadowRepositoryIds = new Set(result.checkpoints.map((checkpoint) => checkpoint.shadowRepositoryId));
  result.conversationCheckpointRepositoryLinks = state.conversationCheckpointRepositoryLinks.filter((link) =>
    projectContextIds.has(link.projectContextId) || shadowRepositoryIds.has(link.shadowRepositoryId)
  );
  result.projectContexts = state.projectContexts.filter((record) => projectContextIds.has(record.id));
  result.shadowRepositories = state.shadowRepositories.filter((record) => shadowRepositoryIds.has(record.id));

  const selectedSeqs = result.messages.map((message) => message.seq);
  const minSeq = selectedSeqs.length > 0 ? Math.min(...selectedSeqs) : undefined;
  const maxSeq = selectedSeqs.length > 0 ? Math.max(...selectedSeqs) : undefined;
  result.compressionBlocks = state.compressionBlocks.filter((block) => {
    const seq = block.anchorSeq ?? block.endSeq;
    return seq !== undefined && minSeq !== undefined && maxSeq !== undefined && seq >= minSeq && seq <= maxSeq;
  });
  const blockIds = new Set(result.compressionBlocks.map((block) => block.id));
  result.compressionBlockSourceLinks = state.compressionBlockSourceLinks.filter((link) => blockIds.has(link.blockId));
  result.compressionContextVariants = state.compressionContextVariants.filter((variant) => blockIds.has(variant.blockId));
  result.compressionBlockLlmInvocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => blockIds.has(link.blockId));

  return result;
}

export function classifyConversationStreamMessageRemovals(
  previousMessages: readonly MessageRecord[],
  nextMessages: readonly MessageRecord[],
  authoritativeMessages: readonly MessageRecord[]
): ConversationStreamMessageRemovalClassification {
  const nextIds = new Set(nextMessages.map((message) => message.id));
  const removedMessages = previousMessages.filter((message) => !nextIds.has(message.id));
  const evictedMessageIds = new Set<string>();
  const semanticMessageIds = new Set<string>();
  if (removedMessages.length === 0) return { evictedMessageIds, semanticMessageIds };

  const authoritativeIds = new Set(authoritativeMessages.map((message) => message.id));
  for (const message of removedMessages) {
    // 仍存在于完整 ECS 投影，只是离开 recent stream window；否则才是领域删除。
    if (authoritativeIds.has(message.id)) evictedMessageIds.add(message.id);
    else semanticMessageIds.add(message.id);
  }

  return { evictedMessageIds, semanticMessageIds };
}
