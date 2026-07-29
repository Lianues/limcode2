import type { ClientState } from '../../shared/protocol';
import { isConversationScopeLinkRecord } from '../../shared/clientStateSchema';

/** 纯数据级 Conversation cascade；ECS、本地 persistence base 与磁盘 snapshot 共用同一语义。 */
export function stripConversationFromClientState(
  state: ClientState,
  conversationId: string,
  options: { additionalRunIds?: Iterable<string> } = {}
): ClientState {
  const removedMessageIds = new Set(state.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id));
  const removedRevisionIds = new Set(state.messageRevisions.filter((revision) => revision.conversationId === conversationId || removedMessageIds.has(revision.messageId)).map((revision) => revision.id));
  const removedToolCallIds = new Set(state.toolCalls.filter((toolCall) => removedMessageIds.has(toolCall.messageId)).map((toolCall) => toolCall.id));
  const removedCompressionBlockIds = new Set(state.compressionBlocks.filter((block) => block.conversationId === conversationId).map((block) => block.id));
  const removedCheckpointIds = new Set(state.checkpoints.filter((checkpoint) => checkpoint.conversationId === conversationId).map((checkpoint) => checkpoint.id));
  for (const anchor of state.checkpointTimelineAnchors) {
    if (anchor.conversationId === conversationId) removedCheckpointIds.add(anchor.checkpointId);
  }

  const removedRunIds = new Set(options.additionalRunIds ?? []);
  for (const link of state.agentRunTargetLinks) if (link.conversationId === conversationId) removedRunIds.add(link.runId);
  for (const link of state.agentRunSourceLinks) {
    if (link.sourceConversationId === conversationId || (link.sourceMessageId && removedMessageIds.has(link.sourceMessageId)) || (link.sourceToolCallId && removedToolCallIds.has(link.sourceToolCallId))) {
      removedRunIds.add(link.runId);
    }
    if (link.sourceRunId && removedRunIds.has(link.sourceRunId)) removedRunIds.add(link.runId);
  }
  for (const link of state.messageRunLinks) if (removedMessageIds.has(link.messageId)) removedRunIds.add(link.runId);
  for (const link of state.toolCallRunLinks) if (removedToolCallIds.has(link.toolCallId)) removedRunIds.add(link.runId);
  for (const input of state.agentRunInputRevisions) if (input.conversationId === conversationId || removedRevisionIds.has(input.revisionId)) removedRunIds.add(input.runId);
  for (const link of state.runCompressionBlockLinks) if (removedCompressionBlockIds.has(link.blockId)) removedRunIds.add(link.runId);

  const removedConversationPolicyIds = new Set(state.runConversationPolicies.filter((policy) => policy.conversationId === conversationId || policy.branchFromConversationId === conversationId).map((policy) => policy.id));
  for (const link of state.runConversationPolicyLinks) if (removedRunIds.has(link.runId)) removedConversationPolicyIds.add(link.policyId);
  const removedContextPolicyIds = new Set(state.runContextPolicyLinks.filter((link) => removedRunIds.has(link.runId)).map((link) => link.policyId));
  const removedDeliveryPolicyIds = new Set(state.runDeliveryPolicyLinks.filter((link) => removedRunIds.has(link.runId)).map((link) => link.policyId));
  for (const policy of state.runDeliveryPolicies) if (policy.targetConversationId === conversationId || (policy.targetToolCallId && removedToolCallIds.has(policy.targetToolCallId))) removedDeliveryPolicyIds.add(policy.id);
  const removedEditPolicyIds = new Set(state.runEditPolicyLinks.filter((link) => removedRunIds.has(link.runId)).map((link) => link.policyId));

  const removedInvocationIds = new Set<string>();
  for (const link of state.runLlmInvocationLinks) if (removedRunIds.has(link.runId)) removedInvocationIds.add(link.invocationId);
  for (const link of state.messageLlmInvocationLinks) if (removedMessageIds.has(link.messageId)) removedInvocationIds.add(link.invocationId);
  for (const link of state.compressionBlockLlmInvocationLinks) if (removedCompressionBlockIds.has(link.blockId)) removedInvocationIds.add(link.invocationId);

  const removedPlanProposalIds = new Set(state.runPlanProposalLinks.filter((link) => removedRunIds.has(link.runId)).map((link) => link.planProposalId));
  const planProposalIdsStillReferenced = new Set(state.runPlanProposalLinks.filter((link) => !removedRunIds.has(link.runId)).map((link) => link.planProposalId));

  const repositoryIdsReferencedByDeletedConversation = new Set<string>();
  for (const checkpoint of state.checkpoints) if (removedCheckpointIds.has(checkpoint.id)) repositoryIdsReferencedByDeletedConversation.add(checkpoint.shadowRepositoryId);
  for (const link of state.conversationCheckpointRepositoryLinks) if (link.conversationId === conversationId) repositoryIdsReferencedByDeletedConversation.add(link.shadowRepositoryId);
  const repositoryIdsStillReferenced = new Set<string>();
  for (const checkpoint of state.checkpoints) if (!removedCheckpointIds.has(checkpoint.id)) repositoryIdsStillReferenced.add(checkpoint.shadowRepositoryId);
  for (const link of state.conversationCheckpointRepositoryLinks) if (link.conversationId !== conversationId) repositoryIdsStillReferenced.add(link.shadowRepositoryId);
  const removedShadowRepositoryIds = new Set([...repositoryIdsReferencedByDeletedConversation].filter((id) => !repositoryIdsStillReferenced.has(id)));

  return {
    ...state,
    conversations: state.conversations.filter((conversation) => conversation.id !== conversationId),
    conversationReuseLinks: state.conversationReuseLinks.filter((link) => link.conversationId !== conversationId),
    conversationBranchLinks: state.conversationBranchLinks.filter((link) => link.sourceConversationId !== conversationId && link.targetConversationId !== conversationId),
    conversationOriginLinks: state.conversationOriginLinks.filter((link) => link.conversationId !== conversationId && link.sourceConversationId !== conversationId && !removedRunIds.has(link.sourceRunId ?? '')),
    agentConversationLinks: state.agentConversationLinks.filter((link) => link.conversationId !== conversationId),
    conversationAgentSelections: state.conversationAgentSelections.filter((selection) => selection.conversationId !== conversationId),
    conversationWorkflowSelections: state.conversationWorkflowSelections.filter((selection) => selection.conversationId !== conversationId),
    conversationProjectLinks: state.conversationProjectLinks.filter((link) => link.conversationId !== conversationId),
    conversationWorkEnvironmentLinks: state.conversationWorkEnvironmentLinks.filter((link) => link.conversationId !== conversationId),
    conversationRuntimeContextSnapshotLinks: state.conversationRuntimeContextSnapshotLinks.filter((link) => link.conversationId !== conversationId),
    checkpointPolicyScopeLinks: state.checkpointPolicyScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    workEnvironmentPolicyScopeLinks: state.workEnvironmentPolicyScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    systemPromptScopeLinks: state.systemPromptScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    modelProfileScopeLinks: state.modelProfileScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    runtimeContextScopeLinks: state.runtimeContextScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    planReviewPolicyScopeLinks: state.planReviewPolicyScopeLinks.filter((link) => !isConversationScopeLinkRecord(link, conversationId)),
    conversationCheckpointRepositoryLinks: state.conversationCheckpointRepositoryLinks.filter((link) => link.conversationId !== conversationId),
    checkpoints: state.checkpoints.filter((checkpoint) => !removedCheckpointIds.has(checkpoint.id)),
    checkpointTimelineAnchors: state.checkpointTimelineAnchors.filter((anchor) => anchor.conversationId !== conversationId && !removedCheckpointIds.has(anchor.checkpointId)),
    shadowRepositories: state.shadowRepositories.filter((repository) => !removedShadowRepositoryIds.has(repository.id)),
    messages: state.messages.filter((message) => message.conversationId !== conversationId),
    messageRevisions: state.messageRevisions.filter((revision) => revision.conversationId !== conversationId && !removedMessageIds.has(revision.messageId)),
    messageCurrentRevisionLinks: state.messageCurrentRevisionLinks.filter((link) => !removedMessageIds.has(link.messageId) && !removedRevisionIds.has(link.revisionId)),
    toolCalls: state.toolCalls.filter((toolCall) => !removedToolCallIds.has(toolCall.id)),
    toolCallEvents: state.toolCallEvents.filter((event) => !removedToolCallIds.has(event.toolCallId)),
    compressionBlocks: state.compressionBlocks.filter((block) => block.conversationId !== conversationId),
    compressionBlockSourceLinks: state.compressionBlockSourceLinks.filter((link) => !removedCompressionBlockIds.has(link.blockId)),
    compressionContextVariants: state.compressionContextVariants.filter((variant) => !removedCompressionBlockIds.has(variant.blockId)),
    runCompressionBlockLinks: state.runCompressionBlockLinks.filter((link) => !removedRunIds.has(link.runId) && !removedCompressionBlockIds.has(link.blockId)),
    runPlanProposalLinks: state.runPlanProposalLinks.filter((link) => !removedRunIds.has(link.runId)),
    planProposals: state.planProposals.filter((proposal) => !removedPlanProposalIds.has(proposal.id) || planProposalIdsStillReferenced.has(proposal.id)),
    compressionBlockLlmInvocationLinks: state.compressionBlockLlmInvocationLinks.filter((link) => !removedCompressionBlockIds.has(link.blockId) && !removedInvocationIds.has(link.invocationId)),
    llmInvocations: state.llmInvocations.filter((invocation) => !removedInvocationIds.has(invocation.id)),
    runLlmInvocationLinks: state.runLlmInvocationLinks.filter((link) => !removedRunIds.has(link.runId) && !removedInvocationIds.has(link.invocationId)),
    messageLlmInvocationLinks: state.messageLlmInvocationLinks.filter((link) => !removedMessageIds.has(link.messageId) && !removedInvocationIds.has(link.invocationId)),
    agentRuns: state.agentRuns.filter((run) => !removedRunIds.has(run.id)),
    agentRunQueueOrders: state.agentRunQueueOrders.filter((order) => !removedRunIds.has(order.runId) && order.conversationId !== conversationId),
    agentRunQueueHolds: state.agentRunQueueHolds.filter((hold) => !removedRunIds.has(hold.runId) && hold.conversationId !== conversationId),
    agentRunQueuedInputs: state.agentRunQueuedInputs.filter((input) => !removedRunIds.has(input.runId) && input.conversationId !== conversationId),
    agentRunSourceLinks: state.agentRunSourceLinks.filter((link) => !removedRunIds.has(link.runId) && !removedRunIds.has(link.sourceRunId ?? '') && link.sourceConversationId !== conversationId && !removedMessageIds.has(link.sourceMessageId ?? '') && !removedToolCallIds.has(link.sourceToolCallId ?? '')),
    agentRunTargetLinks: state.agentRunTargetLinks.filter((link) => !removedRunIds.has(link.runId) && link.conversationId !== conversationId),
    messageRunLinks: state.messageRunLinks.filter((link) => !removedRunIds.has(link.runId) && !removedMessageIds.has(link.messageId)),
    toolCallRunLinks: state.toolCallRunLinks.filter((link) => !removedRunIds.has(link.runId) && !removedToolCallIds.has(link.toolCallId)),
    runConversationPolicies: state.runConversationPolicies.filter((policy) => !removedConversationPolicyIds.has(policy.id)),
    runContextPolicies: state.runContextPolicies.filter((policy) => !removedContextPolicyIds.has(policy.id)),
    runDeliveryPolicies: state.runDeliveryPolicies.filter((policy) => !removedDeliveryPolicyIds.has(policy.id)),
    runEditPolicies: state.runEditPolicies.filter((policy) => !removedEditPolicyIds.has(policy.id)),
    runWorkflowLinks: state.runWorkflowLinks.filter((link) => !removedRunIds.has(link.runId)),
    runSystemPromptLinks: state.runSystemPromptLinks.filter((link) => !removedRunIds.has(link.runId)),
    runModelProfileLinks: state.runModelProfileLinks.filter((link) => !removedRunIds.has(link.runId)),
    runToolPolicyLinks: state.runToolPolicyLinks.filter((link) => !removedRunIds.has(link.runId)),
    runRuntimeContextSnapshotLinks: state.runRuntimeContextSnapshotLinks.filter((link) => !removedRunIds.has(link.runId)),
    runWorkEnvironmentLinks: state.runWorkEnvironmentLinks.filter((link) => !removedRunIds.has(link.runId)),
    runConversationPolicyLinks: state.runConversationPolicyLinks.filter((link) => !removedRunIds.has(link.runId) && !removedConversationPolicyIds.has(link.policyId)),
    runContextPolicyLinks: state.runContextPolicyLinks.filter((link) => !removedRunIds.has(link.runId) && !removedContextPolicyIds.has(link.policyId)),
    runDeliveryPolicyLinks: state.runDeliveryPolicyLinks.filter((link) => !removedRunIds.has(link.runId) && !removedDeliveryPolicyIds.has(link.policyId)),
    runEditPolicyLinks: state.runEditPolicyLinks.filter((link) => !removedRunIds.has(link.runId) && !removedEditPolicyIds.has(link.policyId)),
    agentRunInputRevisions: state.agentRunInputRevisions.filter((input) => !removedRunIds.has(input.runId) && input.conversationId !== conversationId && !removedRevisionIds.has(input.revisionId))
  };
}
