import type {
  AgentRunInputRevisionRecord,
  AgentRunRecord,
  AgentRunSourceLinkRecord,
  AgentRunTargetLinkRecord,
  ClientPatchOp,
  ClientState,
  MessageRunLinkRecord,
  RunApprovalPolicyLinkRecord,
  RunContextPolicyLinkRecord,
  RunContextPolicyRecord,
  RunConversationPolicyLinkRecord,
  RunConversationPolicyRecord,
  RunDeliveryPolicyLinkRecord,
  RunDeliveryPolicyRecord,
  RunEditPolicyLinkRecord,
  RunEditPolicyRecord,
  RunModeLinkRecord,
  RunModelProfileLinkRecord,
  RunSystemPromptLinkRecord,
  RunToolPolicyLinkRecord,
  ToolCallRunLinkRecord
} from '../../../../shared/protocol';
import type { WorldReader } from '../../../ecs/types';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor, type ClientStateSlice } from '../../clientSync/contributors';
import { Agent } from '../agent/components';
import { Conversation, Message, MessageRevision } from '../chat/components';
import { AgentMode, ApprovalPolicy, ModelProfile, SystemPrompt, ToolPolicy } from '../mode/components';
import { ToolCall } from '../tools/components';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunApprovalPolicyLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunConversationPolicy,
  RunConversationPolicyLink,
  RunDeliveryPolicy,
  RunDeliveryPolicyLink,
  RunEditPolicy,
  RunEditPolicyLink,
  RunModeLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from './components';

export function projectAgentRunClientState(world: WorldReader): ClientStateSlice {
  return {
    agentRuns: world.query(AgentRun).map((entity): AgentRunRecord => ({ ...world.get(entity, AgentRun)! })),
    agentRunSourceLinks: world.query(AgentRunSourceLink).map((entity) => buildSourceLinkRecord(world, entity)).filter(isDefined),
    agentRunTargetLinks: world.query(AgentRunTargetLink).map((entity) => buildTargetLinkRecord(world, entity)).filter(isDefined),
    messageRunLinks: world.query(MessageRunLink).map((entity) => buildMessageRunLinkRecord(world, entity)).filter(isDefined),
    toolCallRunLinks: world.query(ToolCallRunLink).map((entity) => buildToolCallRunLinkRecord(world, entity)).filter(isDefined),
    runConversationPolicies: world.query(RunConversationPolicy).map((entity): RunConversationPolicyRecord => ({ ...world.get(entity, RunConversationPolicy)! })),
    runContextPolicies: world.query(RunContextPolicy).map((entity): RunContextPolicyRecord => ({ ...world.get(entity, RunContextPolicy)! })),
    runDeliveryPolicies: world.query(RunDeliveryPolicy).map((entity) => buildDeliveryPolicyRecord(world, entity)).filter(isDefined),
    runEditPolicies: world.query(RunEditPolicy).map((entity): RunEditPolicyRecord => ({ ...world.get(entity, RunEditPolicy)! })),
    runModeLinks: world.query(RunModeLink).map((entity) => buildRunModeLinkRecord(world, entity)).filter(isDefined),
    runSystemPromptLinks: world.query(RunSystemPromptLink).map((entity) => buildRunSystemPromptLinkRecord(world, entity)).filter(isDefined),
    runModelProfileLinks: world.query(RunModelProfileLink).map((entity) => buildRunModelProfileLinkRecord(world, entity)).filter(isDefined),
    runToolPolicyLinks: world.query(RunToolPolicyLink).map((entity) => buildRunToolPolicyLinkRecord(world, entity)).filter(isDefined),
    runApprovalPolicyLinks: world.query(RunApprovalPolicyLink).map((entity) => buildRunApprovalPolicyLinkRecord(world, entity)).filter(isDefined),
    runConversationPolicyLinks: world.query(RunConversationPolicyLink).map((entity) => buildRunPolicyLinkRecord(world, entity, RunConversationPolicyLink, RunConversationPolicy)).filter(isDefined),
    runContextPolicyLinks: world.query(RunContextPolicyLink).map((entity) => buildRunPolicyLinkRecord(world, entity, RunContextPolicyLink, RunContextPolicy)).filter(isDefined),
    runDeliveryPolicyLinks: world.query(RunDeliveryPolicyLink).map((entity) => buildRunPolicyLinkRecord(world, entity, RunDeliveryPolicyLink, RunDeliveryPolicy)).filter(isDefined),
    runEditPolicyLinks: world.query(RunEditPolicyLink).map((entity) => buildRunPolicyLinkRecord(world, entity, RunEditPolicyLink, RunEditPolicy)).filter(isDefined),
    agentRunInputRevisions: world.query(AgentRunInputRevision).map((entity) => buildInputRevisionRecord(world, entity)).filter(isDefined)
  };
}

export function diffAgentRunClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  return [
    ...diffUpsertRemove(prev.agentRuns, next.agentRuns, (run): ClientPatchOp => ({ kind: 'agentRun.upsert', run }), (id): ClientPatchOp => ({ kind: 'agentRun.remove', id })),
    ...diffUpsertRemove(prev.agentRunSourceLinks, next.agentRunSourceLinks, (link): ClientPatchOp => ({ kind: 'agentRunSourceLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'agentRunSourceLink.remove', id })),
    ...diffUpsertRemove(prev.agentRunTargetLinks, next.agentRunTargetLinks, (link): ClientPatchOp => ({ kind: 'agentRunTargetLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'agentRunTargetLink.remove', id })),
    ...diffUpsertRemove(prev.messageRunLinks, next.messageRunLinks, (link): ClientPatchOp => ({ kind: 'messageRunLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'messageRunLink.remove', id })),
    ...diffUpsertRemove(prev.toolCallRunLinks, next.toolCallRunLinks, (link): ClientPatchOp => ({ kind: 'toolCallRunLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'toolCallRunLink.remove', id })),
    ...diffUpsertRemove(prev.runConversationPolicies, next.runConversationPolicies, (policy): ClientPatchOp => ({ kind: 'runConversationPolicy.upsert', policy }), (id): ClientPatchOp => ({ kind: 'runConversationPolicy.remove', id })),
    ...diffUpsertRemove(prev.runContextPolicies, next.runContextPolicies, (policy): ClientPatchOp => ({ kind: 'runContextPolicy.upsert', policy }), (id): ClientPatchOp => ({ kind: 'runContextPolicy.remove', id })),
    ...diffUpsertRemove(prev.runDeliveryPolicies, next.runDeliveryPolicies, (policy): ClientPatchOp => ({ kind: 'runDeliveryPolicy.upsert', policy }), (id): ClientPatchOp => ({ kind: 'runDeliveryPolicy.remove', id })),
    ...diffUpsertRemove(prev.runEditPolicies, next.runEditPolicies, (policy): ClientPatchOp => ({ kind: 'runEditPolicy.upsert', policy }), (id): ClientPatchOp => ({ kind: 'runEditPolicy.remove', id })),
    ...diffUpsertRemove(prev.runModeLinks, next.runModeLinks, (link): ClientPatchOp => ({ kind: 'runModeLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runModeLink.remove', id })),
    ...diffUpsertRemove(prev.runSystemPromptLinks, next.runSystemPromptLinks, (link): ClientPatchOp => ({ kind: 'runSystemPromptLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runSystemPromptLink.remove', id })),
    ...diffUpsertRemove(prev.runModelProfileLinks, next.runModelProfileLinks, (link): ClientPatchOp => ({ kind: 'runModelProfileLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runModelProfileLink.remove', id })),
    ...diffUpsertRemove(prev.runToolPolicyLinks, next.runToolPolicyLinks, (link): ClientPatchOp => ({ kind: 'runToolPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runToolPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.runApprovalPolicyLinks, next.runApprovalPolicyLinks, (link): ClientPatchOp => ({ kind: 'runApprovalPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runApprovalPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.runConversationPolicyLinks, next.runConversationPolicyLinks, (link): ClientPatchOp => ({ kind: 'runConversationPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runConversationPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.runContextPolicyLinks, next.runContextPolicyLinks, (link): ClientPatchOp => ({ kind: 'runContextPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runContextPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.runDeliveryPolicyLinks, next.runDeliveryPolicyLinks, (link): ClientPatchOp => ({ kind: 'runDeliveryPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runDeliveryPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.runEditPolicyLinks, next.runEditPolicyLinks, (link): ClientPatchOp => ({ kind: 'runEditPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runEditPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.agentRunInputRevisions, next.agentRunInputRevisions, (inputRevision): ClientPatchOp => ({ kind: 'agentRunInputRevision.upsert', inputRevision }), (id): ClientPatchOp => ({ kind: 'agentRunInputRevision.remove', id }))
  ];
}

export const agentRunClientSyncContributor = defineClientStateContributor({
  key: 'agentRuns',
  reads: {
    components: [
      Agent,
      Conversation,
      Message,
      MessageRevision,
      ToolCall,
      AgentMode,
      ToolPolicy,
      ApprovalPolicy,
      SystemPrompt,
      ModelProfile,
      AgentRun,
      AgentRunSourceLink,
      AgentRunTargetLink,
      MessageRunLink,
      ToolCallRunLink,
      RunConversationPolicy,
      RunContextPolicy,
      RunDeliveryPolicy,
      RunEditPolicy,
      RunModeLink,
      RunSystemPromptLink,
      RunModelProfileLink,
      RunToolPolicyLink,
      RunApprovalPolicyLink,
      RunConversationPolicyLink,
      RunContextPolicyLink,
      RunDeliveryPolicyLink,
      RunEditPolicyLink,
      AgentRunInputRevision
    ]
  },
  project: projectAgentRunClientState,
  diff: diffAgentRunClientState,
  worker: {
    modulePath: '../world/modules/agentRun/clientSync',
    projectExport: 'projectAgentRunClientState',
    diffExport: 'diffAgentRunClientState'
  }
});

function buildSourceLinkRecord(world: WorldReader, entity: number): AgentRunSourceLinkRecord | undefined {
  const link = world.get(entity, AgentRunSourceLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  if (!run) return undefined;
  return {
    id: link.id,
    runId: run.id,
    sourceKind: link.sourceKind,
    ...(link.sourceAgent !== undefined ? { sourceAgentId: world.get(link.sourceAgent, Agent)?.id } : {}),
    ...(link.sourceConversation !== undefined ? { sourceConversationId: world.get(link.sourceConversation, Conversation)?.id } : {}),
    ...(link.sourceMessage !== undefined ? { sourceMessageId: world.get(link.sourceMessage, Message)?.id } : {}),
    ...(link.sourceToolCall !== undefined ? { sourceToolCallId: world.get(link.sourceToolCall, ToolCall)?.id } : {}),
    ...(link.sourceRun !== undefined ? { sourceRunId: world.get(link.sourceRun, AgentRun)?.id } : {})
  };
}

function buildTargetLinkRecord(world: WorldReader, entity: number): AgentRunTargetLinkRecord | undefined {
  const link = world.get(entity, AgentRunTargetLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const agent = world.get(link.agent, Agent);
  const conversation = world.get(link.conversation, Conversation);
  if (!run || !agent || !conversation) return undefined;
  return { id: link.id, runId: run.id, agentId: agent.id, conversationId: conversation.id, role: link.role };
}

function buildMessageRunLinkRecord(world: WorldReader, entity: number): MessageRunLinkRecord | undefined {
  const link = world.get(entity, MessageRunLink);
  if (!link) return undefined;
  const message = world.get(link.message, Message);
  const run = world.get(link.run, AgentRun);
  if (!message || !run) return undefined;
  return { id: link.id, messageId: message.id, runId: run.id, role: link.role };
}

function buildToolCallRunLinkRecord(world: WorldReader, entity: number): ToolCallRunLinkRecord | undefined {
  const link = world.get(entity, ToolCallRunLink);
  if (!link) return undefined;
  const toolCall = world.get(link.toolCall, ToolCall);
  const run = world.get(link.run, AgentRun);
  if (!toolCall || !run) return undefined;
  return { id: link.id, toolCallId: toolCall.id, runId: run.id, role: link.role };
}

function buildDeliveryPolicyRecord(world: WorldReader, entity: number): RunDeliveryPolicyRecord | undefined {
  const policy = world.get(entity, RunDeliveryPolicy);
  if (!policy) return undefined;
  return {
    id: policy.id,
    mode: policy.mode,
    includeTranscript: policy.includeTranscript,
    ...(policy.targetConversation !== undefined ? { targetConversationId: world.get(policy.targetConversation, Conversation)?.id } : {}),
    ...(policy.targetToolCall !== undefined ? { targetToolCallId: world.get(policy.targetToolCall, ToolCall)?.id } : {})
  };
}

function buildRunModeLinkRecord(world: WorldReader, entity: number): RunModeLinkRecord | undefined {
  const link = world.get(entity, RunModeLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const mode = world.get(link.mode, AgentMode);
  if (!run || !mode) return undefined;
  return { id: link.id, runId: run.id, modeId: mode.id, role: link.role };
}

function buildRunSystemPromptLinkRecord(world: WorldReader, entity: number): RunSystemPromptLinkRecord | undefined {
  const link = world.get(entity, RunSystemPromptLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const systemPrompt = world.get(link.systemPrompt, SystemPrompt);
  if (!run || !systemPrompt) return undefined;
  return { id: link.id, runId: run.id, systemPromptId: systemPrompt.id, role: link.role };
}

function buildRunModelProfileLinkRecord(world: WorldReader, entity: number): RunModelProfileLinkRecord | undefined {
  const link = world.get(entity, RunModelProfileLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const modelProfile = world.get(link.modelProfile, ModelProfile);
  if (!run || !modelProfile) return undefined;
  return { id: link.id, runId: run.id, modelProfileId: modelProfile.id, role: link.role };
}

function buildRunToolPolicyLinkRecord(world: WorldReader, entity: number): RunToolPolicyLinkRecord | undefined {
  const link = world.get(entity, RunToolPolicyLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const toolPolicy = world.get(link.toolPolicy, ToolPolicy);
  if (!run || !toolPolicy) return undefined;
  return { id: link.id, runId: run.id, toolPolicyId: toolPolicy.id, role: link.role };
}

function buildRunApprovalPolicyLinkRecord(world: WorldReader, entity: number): RunApprovalPolicyLinkRecord | undefined {
  const link = world.get(entity, RunApprovalPolicyLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const approvalPolicy = world.get(link.approvalPolicy, ApprovalPolicy);
  if (!run || !approvalPolicy) return undefined;
  return { id: link.id, runId: run.id, approvalPolicyId: approvalPolicy.id, role: link.role };
}

function buildRunPolicyLinkRecord<TLink extends { id: string; run: number; policy: number; role: 'active' }>(
  world: WorldReader,
  entity: number,
  linkType: { id: symbol },
  policyType: { id: symbol }
): RunConversationPolicyLinkRecord | RunContextPolicyLinkRecord | RunDeliveryPolicyLinkRecord | RunEditPolicyLinkRecord | undefined {
  const link = world.get(entity, linkType as never) as TLink | undefined;
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const policy = world.get(link.policy, policyType as never) as { id: string } | undefined;
  if (!run || !policy) return undefined;
  return { id: link.id, runId: run.id, policyId: policy.id, role: link.role };
}

function buildInputRevisionRecord(world: WorldReader, entity: number): AgentRunInputRevisionRecord | undefined {
  const input = world.get(entity, AgentRunInputRevision);
  if (!input) return undefined;
  const run = world.get(input.run, AgentRun);
  const conversation = world.get(input.conversation, Conversation);
  const revision = world.get(input.revision, MessageRevision);
  if (!run || !conversation || !revision) return undefined;
  return { id: input.id, runId: run.id, conversationId: conversation.id, revisionId: revision.id };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
