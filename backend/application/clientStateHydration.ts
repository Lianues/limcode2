import type { Entity, World } from '../ecs/types';
import { Agent, AgentConversationLink, AgentKind, AgentStatus, ConversationAgentSelection } from '../world/modules/agent/components';
import {
  ConversationModeSelection,
  Mode,
  ModelProfile,
  ModelProfileScopeLink,
  SystemPrompt,
  SystemPromptScopeLink,
  ToolPolicy
} from '../world/modules/mode/components';
import {
  ConversationRuntimeContextSnapshotLink,
  RuntimeContext,
  RuntimeContextScopeLink,
  RuntimeContextSnapshot,
  RunRuntimeContextSnapshotLink
} from '../world/modules/runtimeContext/components';
import { rememberHydratedMessageSeq, resetMessageSeqState } from '../world/modules/chat/bundles';
import {
  Conversation,
  ConversationBranchLink,
  ConversationOriginLink,
  ConversationReuseLink,
  Message,
  MessageCurrentRevisionLink,
  MessageRevision,
  PartOf
} from '../world/modules/chat/components';
import { ConversationProjectLink, ProjectContext } from '../world/modules/project/components';
import { ToolCall, ToolCallEvent, ToolPolicyScopeLink, ToolResultConsumed, ToolState } from '../world/modules/tools/components';
import { isTerminalToolStatus } from '../world/modules/tools/state';
import { SkillPolicy, SkillPolicyScopeLink } from '../world/modules/skill/components';
import {
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink
} from '../world/modules/workEnvironment/components';
import {
  Checkpoint,
  CheckpointPolicy,
  CheckpointPolicyScopeLink,
  CheckpointTimelineAnchor,
  ConversationCheckpointRepositoryLink,
  ShadowRepository
} from '../world/modules/checkpoint/components';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunQueueHold,
  AgentRunQueueOrder,
  AgentRunQueuedInput,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
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
} from '../world/modules/agentRun/components';
import {
  AgentAnswer,
  AgentAnswerSubmissionLink,
  AgentAnswerTargetLink
} from '../world/modules/agentAnswer/components';
import {
  LlmInvocation,
  MessageLlmInvocationLink,
  RunLlmInvocationLink
} from '../world/modules/llm/components';
import {
  CompressionBlock,
  CompressionBlockLlmInvocationLink,
  CompressionBlockSourceLink,
  CompressionContextVariant,
  RunCompressionBlockLink
} from '../world/modules/compression/components';
import type { ClientState, MessageRecord, ToolCallEventRecord, ToolCallRecord } from '../../shared/protocol';
import { createDefaultAgentRecord, DEFAULT_AGENT_NAME, DEFAULT_CONVERSATION_ID } from './defaults';

export interface HydrateClientStateSkeletonOptions {
  allowDefaults?: boolean;
  resetMessageSeq?: boolean;
}

export function hydrateClientStateSkeleton(world: World, state: ClientState, options: HydrateClientStateSkeletonOptions = {}): boolean {
  const allowDefaults = options.allowDefaults ?? true;
  const resetSeq = options.resetMessageSeq ?? true;
  if (resetSeq) resetMessageSeqState();

  const hasAnyState = hasClientStateRecords(state);
  if (!hasAnyState) return false;

  const agentEntities = existingRecords(world, Agent);
  const conversationEntities = existingRecords(world, Conversation);
  const defaultAgent = createDefaultAgentRecord();
  const agents = state.agents.length > 0
    ? state.agents
    : allowDefaults && agentEntities.size === 0 ? [defaultAgent] : [];
  const conversations = state.conversations.length > 0
    ? state.conversations
    : allowDefaults && conversationEntities.size === 0 ? [{ id: DEFAULT_CONVERSATION_ID }] : [];

  for (const agent of agents) {
    const existing = agentEntities.get(agent.id);
    const entity = existing ?? world.spawn();
    agentEntities.set(agent.id, entity);
    world.add(entity, Agent, { id: agent.id, name: agent.name || DEFAULT_AGENT_NAME, ...(agent.description ? { description: agent.description } : {}), source: agent.source ?? 'user' });
    world.add(entity, AgentKind, { kind: agent.kind || 'main' });
    world.add(entity, AgentStatus, { status: agent.status ?? 'idle' });
  }

  const modeEntities = hydrateRecordsUnique(world, state.modes, Mode);
  const toolPolicyEntities = hydrateRecordsUnique(world, state.toolPolicies, ToolPolicy);
  const skillPolicyEntities = hydrateRecordsUnique(world, state.skillPolicies, SkillPolicy);
  const systemPromptEntities = hydrateRecordsUnique(world, state.systemPrompts, SystemPrompt);
  const runtimeContextEntities = hydrateRecordsUnique(world, state.runtimeContexts, RuntimeContext);
  const runtimeContextSnapshotEntities = existingRecords(world, RuntimeContextSnapshot);
  const modelProfileEntities = hydrateRecordsUnique(world, state.modelProfiles, ModelProfile);

  hydrateSystemPromptScopeLinks(world, state, { agents: agentEntities, conversations: new Map(), modes: modeEntities, runs: new Map(), prompts: systemPromptEntities });
  hydrateRuntimeContextScopeLinks(world, state, { agents: agentEntities, conversations: new Map(), modes: modeEntities, runs: new Map(), runtimeContexts: runtimeContextEntities });
  hydrateModelProfileScopeLinks(world, state, { agents: agentEntities, conversations: new Map(), modes: modeEntities, runs: new Map(), profiles: modelProfileEntities });

  for (const conversation of conversations) {
    const existing = conversationEntities.get(conversation.id);
    const entity = existing ?? world.spawn();
    conversationEntities.set(conversation.id, entity);
    world.add(entity, Conversation, { id: conversation.id, title: conversation.title, visibility: conversation.visibility ?? 'visible' });
  }

  hydrateConversationOriginLinks(world, state, { conversations: conversationEntities, agents: agentEntities });

  const conversationReuseLinkIds = existingIds(world, ConversationReuseLink);
  for (const record of state.conversationReuseLinks ?? []) {
    if (conversationReuseLinkIds.has(record.id)) continue;
    const conversation = conversationEntities.get(record.conversationId);
    if (conversation === undefined) continue;
    const agent = record.agentId ? agentEntities.get(record.agentId) : undefined;
    const entity = world.spawn();
    const now = Date.now();
    world.add(entity, ConversationReuseLink, { id: record.id, key: record.key, conversation, ...(agent !== undefined ? { agent } : {}), createdAt: now, updatedAt: now });
  }

  const projectContextEntities = hydrateRecordsUnique(world, state.projectContexts ?? [], ProjectContext);
  const workEnvironmentEntities = hydrateRecordsUnique(world, state.workEnvironments ?? [], WorkEnvironment);
  const workEnvironmentPolicyEntities = hydrateRecordsUnique(world, state.workEnvironmentPolicies ?? [], WorkEnvironmentPolicy);
  const checkpointPolicyEntities = hydrateRecordsUnique(world, state.checkpointPolicies ?? [], CheckpointPolicy);
  const agentAnswerEntities = hydrateRecordsUnique(world, state.agentAnswers ?? [], AgentAnswer);
  const shadowRepositoryEntities = hydrateRecordsUnique(world, state.shadowRepositories ?? [], ShadowRepository);

  const conversationProjectLinkIds = existingIds(world, ConversationProjectLink);
  for (const link of state.conversationProjectLinks ?? []) {
    if (conversationProjectLinkIds.has(link.id)) continue;
    const conversation = conversationEntities.get(link.conversationId);
    const projectContext = projectContextEntities.get(link.projectContextId);
    if (conversation === undefined || projectContext === undefined) continue;
    const entity = world.spawn();
    world.add(entity, ConversationProjectLink, {
      id: link.id,
      conversation,
      projectContext,
      role: link.role,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt
    });
  }

  const conversationWorkEnvironmentLinkIds = existingIds(world, ConversationWorkEnvironmentLink);
  for (const link of state.conversationWorkEnvironmentLinks ?? []) {
    if (conversationWorkEnvironmentLinkIds.has(link.id)) continue;
    const conversation = conversationEntities.get(link.conversationId);
    const workEnvironment = workEnvironmentEntities.get(link.workEnvironmentId);
    if (conversation === undefined || workEnvironment === undefined) continue;
    const entity = world.spawn();
    world.add(entity, ConversationWorkEnvironmentLink, {
      id: link.id,
      conversation,
      workEnvironment,
      role: link.role,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt
    });
  }

  hydrateWorkEnvironmentPolicyScopeLinks(world, state, { conversations: conversationEntities, modes: modeEntities, agents: agentEntities, runs: new Map(), policies: workEnvironmentPolicyEntities });
  hydrateCheckpointPolicyScopeLinks(world, state, { conversations: conversationEntities, modes: modeEntities, agents: agentEntities, runs: new Map(), policies: checkpointPolicyEntities });
  hydrateCheckpointRecords(world, state, { conversations: conversationEntities, projectContexts: projectContextEntities, shadowRepositories: shadowRepositoryEntities, messages: new Map(), runs: new Map(), toolCalls: new Map() });

  const agentConversationLinkIds = existingIds(world, AgentConversationLink);
  for (const link of state.agentConversationLinks) {
    if (agentConversationLinkIds.has(link.id)) continue;
    const agent = agentEntities.get(link.agentId);
    const conversation = conversationEntities.get(link.conversationId);
    if (agent === undefined || conversation === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
    world.add(entity, AgentConversationLink, { id: link.id, agent, conversation, role: link.role, createdAt: now, updatedAt: now });
  }

  hydrateConversationAgentSelections(world, state, conversationEntities, agentEntities);

  const conversationBranchLinkIds = existingIds(world, ConversationBranchLink);
  for (const record of state.conversationBranchLinks ?? []) {
    if (conversationBranchLinkIds.has(record.id)) continue;
    const sourceConversation = conversationEntities.get(record.sourceConversationId);
    const targetConversation = conversationEntities.get(record.targetConversationId);
    if (sourceConversation === undefined || targetConversation === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
    world.add(entity, ConversationBranchLink, { id: record.id, sourceConversation, targetConversation, kind: record.kind, createdAt: now, updatedAt: now });
  }

  hydrateConversationModeSelections(world, state, conversationEntities, modeEntities);

  hydrateToolPolicyScopeLinks(world, state, {
    agents: agentEntities,
    conversations: conversationEntities,
    modes: modeEntities,
    toolPolicies: toolPolicyEntities,
    runs: new Map()
  });

  hydrateSkillPolicyScopeLinks(world, state, {
    agents: agentEntities,
    conversations: conversationEntities,
    modes: modeEntities,
    skillPolicies: skillPolicyEntities,
    runs: new Map()
  });
  hydrateAgentAnswerLinks(world, state, { answers: agentAnswerEntities, agents: agentEntities, conversations: conversationEntities, runs: new Map(), toolCalls: new Map() });
  hydrateSystemPromptScopeLinks(world, state, { agents: agentEntities, conversations: conversationEntities, modes: modeEntities, runs: new Map(), prompts: systemPromptEntities });
  hydrateRuntimeContextScopeLinks(world, state, { agents: agentEntities, conversations: conversationEntities, modes: modeEntities, runs: new Map(), runtimeContexts: runtimeContextEntities });
  hydrateRuntimeContextSnapshots(world, state, conversationEntities, runtimeContextEntities, runtimeContextSnapshotEntities);
  hydrateConversationRuntimeContextSnapshotLinks(world, state, conversationEntities, runtimeContextSnapshotEntities);
  hydrateModelProfileScopeLinks(world, state, { agents: agentEntities, conversations: conversationEntities, modes: modeEntities, runs: new Map(), profiles: modelProfileEntities });

  return true;
}

function hasClientStateRecords(state: ClientState): boolean {
  return (Object.values(state) as unknown[]).some((value) => Array.isArray(value) && value.length > 0);
}

export async function hydrateConversationDetail(world: World, state: ClientState, conversationId: string): Promise<boolean> {
  const conversationEntities = existingRecords(world, Conversation);
  const conversation = conversationEntities.get(conversationId);
  if (conversation === undefined) return false;
  const yieldHydration = createHydrationYield();

  const agentEntities = existingRecords(world, Agent);
  const modeEntities = existingRecords(world, Mode);
  const toolPolicyEntities = existingRecords(world, ToolPolicy);
  const systemPromptEntities = existingRecords(world, SystemPrompt);
  const modelProfileEntities = existingRecords(world, ModelProfile);
  const projectContextEntities = existingRecords(world, ProjectContext);
  const workEnvironmentEntities = existingRecords(world, WorkEnvironment);
  const workEnvironmentPolicyEntities = existingRecords(world, WorkEnvironmentPolicy);
  const checkpointPolicyEntities = hydrateRecordsUnique(world, state.checkpointPolicies ?? [], CheckpointPolicy);
  const shadowRepositoryEntities = hydrateRecordsUnique(world, state.shadowRepositories ?? [], ShadowRepository);
  const runtimeContextEntities = existingRecords(world, RuntimeContext);
  const runtimeContextSnapshotEntities = existingRecords(world, RuntimeContextSnapshot);

  const messageEntities = existingRecords(world, Message);
  for (const record of state.messages.filter((message) => message.conversationId === conversationId)) {
    if (messageEntities.has(record.id)) continue;
    const entity = spawnHydratedMessage(world, conversation, record);
    messageEntities.set(record.id, entity);
    await yieldHydration();
  }

  const revisionEntities = existingRecords(world, MessageRevision);
  for (const record of state.messageRevisions ?? []) {
    const message = messageEntities.get(record.messageId);
    if (message === undefined || revisionEntities.has(record.id)) continue;
    const entity = world.spawn();
    revisionEntities.set(record.id, entity);
    world.add(entity, MessageRevision, { id: record.id, content: record.content, createdAt: record.createdAt, reason: record.reason });
    world.add(entity, PartOf, { parent: message });
    await yieldHydration();
  }

  const currentRevisionLinkIds = existingIds(world, MessageCurrentRevisionLink);
  for (const record of state.messageCurrentRevisionLinks ?? []) {
    if (currentRevisionLinkIds.has(record.id)) continue;
    const message = messageEntities.get(record.messageId);
    const revision = revisionEntities.get(record.revisionId);
    if (message === undefined || revision === undefined) continue;
    const entity = world.spawn();
    currentRevisionLinkIds.add(record.id);
    world.add(entity, MessageCurrentRevisionLink, { id: record.id, message, revision });
    await yieldHydration();
  }

  const toolCallEntities = existingRecords(world, ToolCall);
  for (const record of state.toolCalls) {
    if (toolCallEntities.has(record.id)) continue;
    const entity = spawnHydratedToolCall(world, messageEntities, record);
    if (entity !== undefined) toolCallEntities.set(record.id, entity);
    await yieldHydration();
  }

  const toolCallEventIds = existingIds(world, ToolCallEvent);
  for (const record of state.toolCallEvents ?? []) {
    if (toolCallEventIds.has(record.id)) continue;
    spawnHydratedToolCallEvent(world, toolCallEntities, record);
    toolCallEventIds.add(record.id);
    await yieldHydration();
  }

  const existingRunIdsBeforeHydration = existingIds(world, AgentRun);
  const runEntities = hydrateRecordsUnique(world, state.agentRuns ?? [], AgentRun);
  const agentAnswerEntities = hydrateRecordsUnique(world, state.agentAnswers ?? [], AgentAnswer);
  const llmInvocationEntities = hydrateLlmInvocationRecords(world, state.llmInvocations ?? []);
  const conversationPolicyEntities = hydrateRecordsUnique(world, state.runConversationPolicies, RunConversationPolicy);
  const contextPolicyEntities = hydrateRecordsUnique(world, state.runContextPolicies, RunContextPolicy);
  const deliveryPolicyEntities = existingRecords(world, RunDeliveryPolicy);
  for (const record of state.runDeliveryPolicies ?? []) {
    if (deliveryPolicyEntities.has(record.id)) continue;
    const entity = world.spawn();
    deliveryPolicyEntities.set(record.id, entity);
    world.add(entity, RunDeliveryPolicy, {
      id: record.id,
      mode: record.mode,
      includeTranscript: record.includeTranscript,
      ...(record.targetConversationId ? { targetConversation: conversationEntities.get(record.targetConversationId) } : {}),
      ...(record.targetToolCallId ? { targetToolCall: toolCallEntities.get(record.targetToolCallId) } : {})
    });
  }
  const editPolicyEntities = hydrateRecordsUnique(world, state.runEditPolicies, RunEditPolicy);

  const sourceLinkIds = existingIds(world, AgentRunSourceLink);
  for (const link of state.agentRunSourceLinks ?? []) {
    if (sourceLinkIds.has(link.id)) continue;
    const run = runEntities.get(link.runId);
    if (run === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
    sourceLinkIds.add(link.id);
    world.add(entity, AgentRunSourceLink, {
      id: link.id,
      run,
      sourceKind: link.sourceKind,
      ...(link.sourceAgentId ? { sourceAgent: agentEntities.get(link.sourceAgentId) } : {}),
      ...(link.sourceConversationId ? { sourceConversation: conversationEntities.get(link.sourceConversationId) } : {}),
      ...(link.sourceMessageId ? { sourceMessage: messageEntities.get(link.sourceMessageId) } : {}),
      ...(link.sourceToolCallId ? { sourceToolCall: toolCallEntities.get(link.sourceToolCallId) } : {}),
      ...(link.sourceRunId ? { sourceRun: runEntities.get(link.sourceRunId) } : {}),
      ...(link.answerBridgeId ? { answerBridgeId: link.answerBridgeId } : {}),
      createdAt: now,
      updatedAt: now
    });
    await yieldHydration();
  }

  const targetLinkIds = existingIds(world, AgentRunTargetLink);
  for (const link of state.agentRunTargetLinks ?? []) {
    if (targetLinkIds.has(link.id)) continue;
    const run = runEntities.get(link.runId);
    const agent = agentEntities.get(link.agentId);
    const targetConversation = conversationEntities.get(link.conversationId);
    if (run === undefined || agent === undefined || targetConversation === undefined) continue;
    const entity = world.spawn();
    const now = Date.now();
    targetLinkIds.add(link.id);
    world.add(entity, AgentRunTargetLink, { id: link.id, run, agent, conversation: targetConversation, role: link.role, createdAt: now, updatedAt: now });
    await yieldHydration();
  }

  hydrateQueueOrderRecords(world, state, runEntities, conversationEntities);
  hydrateQueueHoldRecords(world, state, runEntities, conversationEntities);
  hydrateQueuedInputRecords(world, state, runEntities, conversationEntities);
  holdRestoredQueuedRuns(world, state, runEntities, conversationEntities, existingRunIdsBeforeHydration);

  hydrateConversationOriginLinks(world, state, { conversations: conversationEntities, agents: agentEntities, messages: messageEntities, toolCalls: toolCallEntities, runs: runEntities });

  hydrateRuntimeContextSnapshots(world, state, conversationEntities, runtimeContextEntities, runtimeContextSnapshotEntities);
  for (const link of state.messageRunLinks ?? []) spawnRunLink(world, messageEntities, runEntities, link, MessageRunLink, 'message', 'run');
  for (const link of state.toolCallRunLinks ?? []) spawnRunLink(world, toolCallEntities, runEntities, link, ToolCallRunLink, 'toolCall', 'run');
  for (const link of state.runModeLinks ?? []) spawnRunLink(world, runEntities, modeEntities, link, RunModeLink, 'run', 'mode');
  for (const link of state.runSystemPromptLinks ?? []) spawnRunLink(world, runEntities, systemPromptEntities, link, RunSystemPromptLink, 'run', 'systemPrompt');
  for (const link of state.runModelProfileLinks ?? []) spawnRunLink(world, runEntities, modelProfileEntities, link, RunModelProfileLink, 'run', 'modelProfile');
  for (const link of state.runToolPolicyLinks ?? []) spawnRunLink(world, runEntities, toolPolicyEntities, link, RunToolPolicyLink, 'run', 'toolPolicy');
  for (const link of state.runConversationPolicyLinks ?? []) spawnRunLink(world, runEntities, conversationPolicyEntities, link, RunConversationPolicyLink, 'run', 'policy');
  for (const link of state.runContextPolicyLinks ?? []) spawnRunLink(world, runEntities, contextPolicyEntities, link, RunContextPolicyLink, 'run', 'policy');
  for (const link of state.runDeliveryPolicyLinks ?? []) spawnRunLink(world, runEntities, deliveryPolicyEntities, link, RunDeliveryPolicyLink, 'run', 'policy');
  for (const link of state.runEditPolicyLinks ?? []) spawnRunLink(world, runEntities, editPolicyEntities, link, RunEditPolicyLink, 'run', 'policy');
  for (const link of state.runWorkEnvironmentLinks ?? []) spawnRunLink(world, runEntities, workEnvironmentEntities, link, RunWorkEnvironmentLink, 'run', 'workEnvironment');
  for (const link of state.runRuntimeContextSnapshotLinks ?? []) spawnRunLink(world, runEntities, runtimeContextSnapshotEntities, link, RunRuntimeContextSnapshotLink, 'run', 'snapshot');
  for (const link of state.runLlmInvocationLinks ?? []) spawnRunLink(world, runEntities, llmInvocationEntities, link, RunLlmInvocationLink, 'run', 'invocation');
  for (const link of state.messageLlmInvocationLinks ?? []) spawnRunLink(world, messageEntities, llmInvocationEntities, link, MessageLlmInvocationLink, 'message', 'invocation');
  hydrateWorkEnvironmentPolicyScopeLinks(world, state, { conversations: conversationEntities, modes: modeEntities, agents: agentEntities, runs: runEntities, policies: workEnvironmentPolicyEntities });
  hydrateCheckpointPolicyScopeLinks(world, state, { conversations: conversationEntities, modes: modeEntities, agents: agentEntities, runs: runEntities, policies: checkpointPolicyEntities });
  hydrateCheckpointRecords(world, state, { conversations: conversationEntities, projectContexts: projectContextEntities, shadowRepositories: shadowRepositoryEntities, messages: messageEntities, runs: runEntities, toolCalls: toolCallEntities });


  hydrateConversationModeSelections(world, state, conversationEntities, modeEntities);

  hydrateToolPolicyScopeLinks(world, state, {
    agents: agentEntities,
    conversations: conversationEntities,
    modes: modeEntities,
    toolPolicies: toolPolicyEntities,
    runs: runEntities
  });
  hydrateSystemPromptScopeLinks(world, state, { agents: agentEntities, conversations: conversationEntities, modes: modeEntities, runs: runEntities, prompts: systemPromptEntities });
  hydrateRuntimeContextScopeLinks(world, state, { agents: agentEntities, conversations: conversationEntities, modes: modeEntities, runs: runEntities, runtimeContexts: runtimeContextEntities });
  hydrateConversationRuntimeContextSnapshotLinks(world, state, conversationEntities, runtimeContextSnapshotEntities);
  hydrateModelProfileScopeLinks(world, state, { agents: agentEntities, conversations: conversationEntities, modes: modeEntities, runs: runEntities, profiles: modelProfileEntities });
  hydrateCompressionRecords(world, state, { conversations: conversationEntities, messages: messageEntities, runs: runEntities, invocations: llmInvocationEntities });
  hydrateAgentAnswerLinks(world, state, { answers: agentAnswerEntities, agents: agentEntities, conversations: conversationEntities, runs: runEntities, toolCalls: toolCallEntities });

  const inputRevisionIds = existingIds(world, AgentRunInputRevision);
  for (const record of state.agentRunInputRevisions ?? []) {
    if (inputRevisionIds.has(record.id)) continue;
    const run = runEntities.get(record.runId);
    const inputConversation = conversationEntities.get(record.conversationId);
    const revision = revisionEntities.get(record.revisionId);
    if (run === undefined || inputConversation === undefined || revision === undefined) continue;
    const entity = world.spawn();
    inputRevisionIds.add(record.id);
    world.add(entity, AgentRunInputRevision, { id: record.id, run, conversation: inputConversation, revision });
    await yieldHydration();
  }

  return true;
}

function createHydrationYield(batchSize = 250): () => Promise<void> {
  let count = 0;
  return async () => {
    count += 1;
    if (count % batchSize !== 0) return;
    await yieldToExtensionHost();
  };
}

function yieldToExtensionHost(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
      return;
    }
    setTimeout(resolve, 0);
  });
}
function hydrateQueueOrderRecords(world: World, state: ClientState, runs: Map<string, Entity>, conversations: Map<string, Entity>): void {
  const existing = existingIds(world, AgentRunQueueOrder);
  for (const record of state.agentRunQueueOrders ?? []) {
    if (existing.has(record.id)) continue;
    const run = runs.get(record.runId);
    const conversation = conversations.get(record.conversationId);
    if (run === undefined || conversation === undefined) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, AgentRunQueueOrder, {
      id: record.id,
      run,
      conversation,
      order: record.order,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });
  }
}

function hydrateQueueHoldRecords(world: World, state: ClientState, runs: Map<string, Entity>, conversations: Map<string, Entity>): void {
  const existing = existingIds(world, AgentRunQueueHold);
  for (const record of state.agentRunQueueHolds ?? []) {
    if (existing.has(record.id)) continue;
    const run = runs.get(record.runId);
    const conversation = conversations.get(record.conversationId);
    if (run === undefined || conversation === undefined) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, AgentRunQueueHold, {
      id: record.id,
      run,
      conversation,
      reason: record.reason,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });
  }
}

function hydrateQueuedInputRecords(world: World, state: ClientState, runs: Map<string, Entity>, conversations: Map<string, Entity>): void {
  const existing = existingIds(world, AgentRunQueuedInput);
  for (const record of state.agentRunQueuedInputs ?? []) {
    if (existing.has(record.id)) continue;
    const run = runs.get(record.runId);
    const conversation = conversations.get(record.conversationId);
    if (run === undefined || conversation === undefined) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, AgentRunQueuedInput, {
      id: record.id,
      run,
      conversation,
      content: record.content,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });
  }
}



function holdRestoredQueuedRuns(
  world: World,
  state: ClientState,
  runs: Map<string, Entity>,
  conversations: Map<string, Entity>,
  existingRunIdsBeforeHydration: ReadonlySet<string>
): void {
  const existingHoldRunIds = new Set(
    world.query(AgentRunQueueHold)
      .map((entity) => world.get(entity, AgentRunQueueHold)?.run)
      .filter((run): run is Entity => run !== undefined)
      .map((run) => world.get(run, AgentRun)?.id)
      .filter((id): id is string => !!id)
  );
  const targetConversationByRunId = new Map((state.agentRunTargetLinks ?? []).map((link) => [link.runId, link.conversationId]));
  const existingHoldIds = existingIds(world, AgentRunQueueHold);
  const now = Date.now();

  for (const record of state.agentRuns ?? []) {
    if (record.status !== 'queued' || existingRunIdsBeforeHydration.has(record.id) || existingHoldRunIds.has(record.id)) continue;
    const run = runs.get(record.id);
    const conversationId = targetConversationByRunId.get(record.id);
    const conversation = conversationId ? conversations.get(conversationId) : undefined;
    if (run === undefined || conversation === undefined) continue;

    const id = `arqh-restored:${record.id}`;
    if (existingHoldIds.has(id)) continue;
    const entity = world.spawn();
    existingHoldIds.add(id);
    existingHoldRunIds.add(record.id);
    world.add(entity, AgentRunQueueHold, { id, run, conversation, reason: 'restored', createdAt: now, updatedAt: now });
  }
}



function hydrateCompressionRecords(
  world: World,
  state: ClientState,
  maps: { conversations: Map<string, Entity>; messages: Map<string, Entity>; runs: Map<string, Entity>; invocations: Map<string, Entity> }
): void {
  const blockEntities = existingRecords(world, CompressionBlock);
  for (const record of state.compressionBlocks ?? []) {
    if (blockEntities.has(record.id)) continue;
    const conversation = maps.conversations.get(record.conversationId);
    if (conversation === undefined) continue;
    const entity = world.spawn();
    blockEntities.set(record.id, entity);
    const hydratedRecord = normalizeHydratedCompressionBlock(record);
    const { conversationId: _conversationId, ...rest } = hydratedRecord;
    world.add(entity, CompressionBlock, { ...rest, conversation });
  }

  const sourceLinkIds = existingIds(world, CompressionBlockSourceLink);
  for (const record of state.compressionBlockSourceLinks ?? []) {
    if (sourceLinkIds.has(record.id)) continue;
    const block = blockEntities.get(record.blockId);
    if (block === undefined) continue;
    const entity = world.spawn();
    sourceLinkIds.add(record.id);
    const { blockId: _blockId, ...rest } = record;
    const source = record.sourceKind === 'message' ? maps.messages.get(record.sourceId) : blockEntities.get(record.sourceId);
    world.add(entity, CompressionBlockSourceLink, { ...rest, block, ...(source !== undefined ? { source } : {}) });
  }

  const variantEntities = existingRecords(world, CompressionContextVariant);
  for (const record of state.compressionContextVariants ?? []) {
    if (variantEntities.has(record.id)) continue;
    const block = blockEntities.get(record.blockId);
    if (block === undefined) continue;
    const entity = world.spawn();
    variantEntities.set(record.id, entity);
    const { blockId: _blockId, ...rest } = record;
    world.add(entity, CompressionContextVariant, { ...rest, block });
  }

  const runLinkIds = existingIds(world, RunCompressionBlockLink);
  for (const record of state.runCompressionBlockLinks ?? []) {
    if (runLinkIds.has(record.id)) continue;
    const run = maps.runs.get(record.runId);
    const block = blockEntities.get(record.blockId);
    if (run === undefined || block === undefined) continue;
    const variant = record.variantId ? variantEntities.get(record.variantId) : undefined;
    const entity = world.spawn();
    runLinkIds.add(record.id);
    const { runId: _runId, blockId: _blockId, variantId: _variantId, ...rest } = record;
    world.add(entity, RunCompressionBlockLink, { ...rest, run, block, ...(variant !== undefined ? { variant } : {}) });
  }

  const invocationLinkIds = existingIds(world, CompressionBlockLlmInvocationLink);
  for (const record of state.compressionBlockLlmInvocationLinks ?? []) {
    if (invocationLinkIds.has(record.id)) continue;
    const block = blockEntities.get(record.blockId);
    const invocation = maps.invocations.get(record.invocationId);
    if (block === undefined || invocation === undefined) continue;
    const entity = world.spawn();
    invocationLinkIds.add(record.id);
    const { blockId: _blockId, invocationId: _invocationId, ...rest } = record;
    world.add(entity, CompressionBlockLlmInvocationLink, { ...rest, block, invocation });
  }
}

function spawnHydratedMessage(world: World, conversation: Entity, record: MessageRecord): Entity {
  const entity = world.spawn();
  world.add(entity, Message, {
    id: record.id,
    role: record.role,
    model: record.model,
    content: record.content,
    status: record.status === 'streaming' ? 'error' : record.status,
    seq: record.seq,
    createdAt: record.createdAt,
    streamOutputDurationMs: record.streamOutputDurationMs,
    usageMetadata: record.usageMetadata,
    stopReason: record.stopReason
  });
  rememberHydratedMessageSeq(conversation, record.seq);
  world.add(entity, PartOf, { parent: conversation });
  return entity;
}

function spawnHydratedToolCall(world: World, messages: Map<string, Entity>, record: ToolCallRecord): Entity | undefined {
  const modelMessage = messages.get(record.messageId);
  if (modelMessage === undefined) return undefined;

  const entity = world.spawn();
  const now = Date.now();
  const interrupted = !isTerminalToolStatus(record.status);
  const status = interrupted ? 'error' : record.status;
  const error = interrupted ? record.error ?? '工具执行因扩展重启中断。' : record.error;

  world.add(entity, ToolCall, { id: record.id, name: record.name, functionCallId: record.functionCallId, argsJson: record.args, createdAt: record.createdAt });
  world.add(entity, PartOf, { parent: modelMessage });
  world.add(entity, ToolState, {
    status,
    updatedAt: record.updatedAt || now,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(record.progress !== undefined ? { progress: record.progress } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {})
  });
  world.add(entity, ToolResultConsumed, true);
  return entity;
}

function spawnHydratedToolCallEvent(world: World, toolCalls: Map<string, Entity>, record: ToolCallEventRecord): void {
  const toolCall = toolCalls.get(record.toolCallId);
  if (toolCall === undefined) return;
  const entity = world.spawn();
  world.add(entity, ToolCallEvent, record);
  world.add(entity, PartOf, { parent: toolCall });
}

function hydrateRecords<T extends { id: string }>(world: World, records: T[] | undefined, component: { id: symbol }): Map<string, Entity> {
  const entities = new Map<string, Entity>();
  for (const record of records ?? []) {
    const entity = world.spawn();
    entities.set(record.id, entity);
    world.add(entity, component as never, record as never);
  }
  return entities;
}

function hydrateRecordsUnique<T extends { id: string }>(world: World, records: T[] | undefined, component: { id: symbol }): Map<string, Entity> {
  const entities = existingRecords<T>(world, component);
  for (const record of records ?? []) {
    if (entities.has(record.id)) continue;
    const entity = world.spawn();
    entities.set(record.id, entity);
    world.add(entity, component as never, record as never);
  }
  return entities;
}

function hydrateLlmInvocationRecords(world: World, records: ClientState['llmInvocations'] | undefined): Map<string, Entity> {
  const entities = existingRecords<ClientState['llmInvocations'][number]>(world, LlmInvocation);
  for (const record of records ?? []) {
    if (entities.has(record.id)) continue;
    const entity = world.spawn();
    entities.set(record.id, entity);
    world.add(entity, LlmInvocation, normalizeHydratedLlmInvocation(record));
  }
  return entities;
}

function normalizeHydratedLlmInvocation(record: ClientState['llmInvocations'][number]): ClientState['llmInvocations'][number] {
  if (record.status !== 'resolving' && record.status !== 'ready' && record.status !== 'streaming') return record;
  const now = Date.now();
  return {
    ...record,
    status: 'error',
    error: record.error ?? 'LLM 调用已中断，未收到完成事件。',
    completedAt: record.completedAt ?? now
  };
}

function normalizeHydratedCompressionBlock(record: ClientState['compressionBlocks'][number]): ClientState['compressionBlocks'][number] {
  if (record.status !== 'pending' && record.status !== 'running') return record;
  const now = Date.now();
  return {
    ...record,
    status: 'error',
    error: record.error ?? '压缩请求已中断，未收到完成事件；请重新生成。',
    updatedAt: Math.max(record.updatedAt, now),
    completedAt: record.completedAt ?? now
  };
}

function existingRecords<T extends { id: string }>(world: World, component: { id: symbol }): Map<string, Entity> {
  const entities = new Map<string, Entity>();
  for (const entity of world.query(component as never)) {
    const record = world.get(entity, component as never) as T | undefined;
    if (record?.id) entities.set(record.id, entity);
  }
  return entities;
}

function existingIds<T extends { id: string }>(world: World, component: { id: symbol }): Set<string> {
  return new Set([...existingRecords<T>(world, component).keys()]);
}

interface ConversationOriginHydrationMaps {
  conversations: Map<string, Entity>;
  agents: Map<string, Entity>;
  messages?: Map<string, Entity>;
  toolCalls?: Map<string, Entity>;
  runs?: Map<string, Entity>;
}

function hydrateConversationOriginLinks(world: World, state: ClientState, maps: ConversationOriginHydrationMaps): void {
  const existing = existingIds(world, ConversationOriginLink);
  for (const record of state.conversationOriginLinks ?? []) {
    if (existing.has(record.id)) continue;
    const conversation = maps.conversations.get(record.conversationId);
    if (conversation === undefined) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, ConversationOriginLink, {
      id: record.id,
      conversation,
      originKind: record.originKind,
      ...(record.sourceKind !== undefined ? { sourceKind: record.sourceKind } : {}),
      ...sourceEntityAndId('sourceAgent', 'sourceAgentId', record.sourceAgentId, maps.agents),
      ...sourceEntityAndId('sourceConversation', 'sourceConversationId', record.sourceConversationId, maps.conversations),
      ...sourceEntityAndId('sourceMessage', 'sourceMessageId', record.sourceMessageId, maps.messages),
      ...sourceEntityAndId('sourceToolCall', 'sourceToolCallId', record.sourceToolCallId, maps.toolCalls),
      ...sourceEntityAndId('sourceRun', 'sourceRunId', record.sourceRunId, maps.runs),
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

function sourceEntityAndId<TEntityKey extends string, TIdKey extends string>(
  entityKey: TEntityKey,
  idKey: TIdKey,
  id: string | undefined,
  entities: Map<string, Entity> | undefined
): Partial<Record<TEntityKey, Entity> & Record<TIdKey, string>> {
  if (!id) return {};
  const entity = entities?.get(id);
  return {
    ...(entity !== undefined ? { [entityKey]: entity } : {}),
    [idKey]: id
  } as Partial<Record<TEntityKey, Entity> & Record<TIdKey, string>>;
}

interface AgentAnswerHydrationMaps {
  answers: Map<string, Entity>;
  agents: Map<string, Entity>;
  conversations: Map<string, Entity>;
  runs: Map<string, Entity>;
  toolCalls: Map<string, Entity>;
}

function hydrateAgentAnswerLinks(world: World, state: ClientState, maps: AgentAnswerHydrationMaps): void {
  const submissionLinks = existingRecords(world, AgentAnswerSubmissionLink);
  for (const record of state.agentAnswerSubmissionLinks ?? []) {
    const answer = maps.answers.get(record.answerId);
    if (answer === undefined) continue;
    const now = Date.now();
    const data = {
      id: record.id,
      answer,
      ...sourceEntityAndId('submitterRun', 'submitterRunId', record.submitterRunId, maps.runs),
      ...sourceEntityAndId('submitterAgent', 'submitterAgentId', record.submitterAgentId, maps.agents),
      ...sourceEntityAndId('submitterConversation', 'submitterConversationId', record.submitterConversationId, maps.conversations),
      ...sourceEntityAndId('submitterToolCall', 'submitterToolCallId', record.submitterToolCallId, maps.toolCalls),
      createdAt: record.createdAt || now,
      updatedAt: record.updatedAt || record.createdAt || now
    };
    const existing = submissionLinks.get(record.id);
    if (existing !== undefined) world.add(existing, AgentAnswerSubmissionLink, data);
    else {
      const entity = world.spawn();
      submissionLinks.set(record.id, entity);
      world.add(entity, AgentAnswerSubmissionLink, data);
    }
  }

  const targetLinks = existingRecords(world, AgentAnswerTargetLink);
  for (const record of state.agentAnswerTargetLinks ?? []) {
    const answer = maps.answers.get(record.answerId);
    if (answer === undefined) continue;
    const now = Date.now();
    const data = {
      id: record.id,
      answer,
      ...sourceEntityAndId('targetRun', 'targetRunId', record.targetRunId, maps.runs),
      ...sourceEntityAndId('targetAgent', 'targetAgentId', record.targetAgentId, maps.agents),
      ...sourceEntityAndId('targetConversation', 'targetConversationId', record.targetConversationId, maps.conversations),
      ...sourceEntityAndId('sourceToolCall', 'sourceToolCallId', record.sourceToolCallId, maps.toolCalls),
      createdAt: record.createdAt || now,
      updatedAt: record.updatedAt || record.createdAt || now
    };
    const existing = targetLinks.get(record.id);
    if (existing !== undefined) world.add(existing, AgentAnswerTargetLink, data);
    else {
      const entity = world.spawn();
      targetLinks.set(record.id, entity);
      world.add(entity, AgentAnswerTargetLink, data);
    }
  }
}



function hydrateConversationModeSelections(
  world: World,
  state: ClientState,
  conversations: Map<string, Entity>,
  modes: Map<string, Entity>
): void {
  const existing = existingIds(world, ConversationModeSelection);
  for (const record of state.conversationModeSelections ?? []) {
    if (existing.has(record.id)) continue;
    const conversation = conversations.get(record.conversationId);
    if (conversation === undefined) continue;
    const mode = record.scopeKind === 'mode' && record.modeId ? modes.get(record.modeId) : undefined;
    if (record.scopeKind === 'mode' && mode === undefined) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, ConversationModeSelection, {
      id: record.id,
      conversation,
      scopeKind: record.scopeKind,
      ...(mode !== undefined ? { mode } : {}),
      role: record.role,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}



function hydrateConversationAgentSelections(
  world: World,
  state: ClientState,
  conversations: Map<string, Entity>,
  agents: Map<string, Entity>
): void {
  const existing = existingIds(world, ConversationAgentSelection);
  for (const record of state.conversationAgentSelections ?? []) {
    if (existing.has(record.id)) continue;
    const conversation = conversations.get(record.conversationId);
    const agent = agents.get(record.agentId);
    if (conversation === undefined || agent === undefined) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, ConversationAgentSelection, {
      id: record.id,
      conversation,
      agent,
      role: record.role,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

interface ConfigScopeHydrationMaps<TTargetKey extends 'prompts' | 'profiles' | 'runtimeContexts'> {
  agents: Map<string, Entity>;
  conversations: Map<string, Entity>;
  modes: Map<string, Entity>;
  runs: Map<string, Entity>;
  prompts?: Map<string, Entity>;
  profiles?: Map<string, Entity>;
  runtimeContexts?: Map<string, Entity>;
}

function hydrateSystemPromptScopeLinks(world: World, state: ClientState, maps: ConfigScopeHydrationMaps<'prompts'>): void {
  const existing = existingIds(world, SystemPromptScopeLink);
  for (const record of state.systemPromptScopeLinks ?? []) {
    if (existing.has(record.id)) continue;
    const systemPrompt = maps.prompts?.get(record.systemPromptId);
    if (systemPrompt === undefined) continue;
    const scope = resolveHydratedConfigScope(record.scopeKind, record.scopeId, maps);
    if (!scope.ok) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, SystemPromptScopeLink, {
      id: record.id,
      scopeKind: record.scopeKind,
      ...(record.scopeId ? { scopeId: record.scopeId } : {}),
      systemPrompt,
      ...scope.data,
      role: record.role,
      ...(record.order !== undefined ? { order: record.order } : {}),
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

function hydrateRuntimeContextScopeLinks(world: World, state: ClientState, maps: ConfigScopeHydrationMaps<'runtimeContexts'>): void {
  const existing = existingIds(world, RuntimeContextScopeLink);
  for (const record of state.runtimeContextScopeLinks ?? []) {
    if (existing.has(record.id)) continue;
    const runtimeContext = maps.runtimeContexts?.get(record.runtimeContextId);
    if (runtimeContext === undefined) continue;
    const scope = resolveHydratedConfigScope(record.scopeKind, record.scopeId, maps);
    if (!scope.ok) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, RuntimeContextScopeLink, {
      id: record.id,
      scopeKind: record.scopeKind,
      ...(record.scopeId ? { scopeId: record.scopeId } : {}),
      runtimeContext,
      ...scope.data,
      role: record.role,
      ...(record.order !== undefined ? { order: record.order } : {}),
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

function hydrateRuntimeContextSnapshots(
  world: World,
  state: ClientState,
  conversations: Map<string, Entity>,
  runtimeContexts: Map<string, Entity>,
  snapshots: Map<string, Entity>
): void {
  for (const record of state.runtimeContextSnapshots ?? []) {
    if (snapshots.has(record.id)) continue;
    const conversation = record.conversationId ? conversations.get(record.conversationId) : undefined;
    if (record.conversationId && conversation === undefined) continue;
    const sourceRuntimeContexts = (record.sourceRuntimeContextIds ?? [])
      .map((id) => runtimeContexts.get(id))
      .filter((entity): entity is Entity => entity !== undefined);
    const entity = world.spawn();
    snapshots.set(record.id, entity);
    world.add(entity, RuntimeContextSnapshot, {
      id: record.id,
      name: record.name,
      text: record.text,
      template: record.template,
      ...(conversation !== undefined ? { conversation } : {}),
      ...(sourceRuntimeContexts.length > 0 ? { sourceRuntimeContexts } : {}),
      ...(record.sourceHash ? { sourceHash: record.sourceHash } : {}),
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now(),
      refreshedAt: record.refreshedAt || record.updatedAt || record.createdAt || Date.now()
    });
  }
}

function hydrateModelProfileScopeLinks(world: World, state: ClientState, maps: ConfigScopeHydrationMaps<'profiles'>): void {
  const existing = existingIds(world, ModelProfileScopeLink);
  for (const record of state.modelProfileScopeLinks ?? []) {
    if (existing.has(record.id)) continue;
    const modelProfile = maps.profiles?.get(record.modelProfileId);
    if (modelProfile === undefined) continue;
    const scope = resolveHydratedConfigScope(record.scopeKind, record.scopeId, maps);
    if (!scope.ok) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, ModelProfileScopeLink, {
      id: record.id,
      scopeKind: record.scopeKind,
      ...(record.scopeId ? { scopeId: record.scopeId } : {}),
      modelProfile,
      ...scope.data,
      role: record.role,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

function hydrateConversationRuntimeContextSnapshotLinks(
  world: World,
  state: ClientState,
  conversations: Map<string, Entity>,
  snapshots: Map<string, Entity>
): void {
  const existing = existingIds(world, ConversationRuntimeContextSnapshotLink);
  for (const record of state.conversationRuntimeContextSnapshotLinks ?? []) {
    if (existing.has(record.id)) continue;
    const conversation = conversations.get(record.conversationId);
    const snapshot = snapshots.get(record.runtimeContextSnapshotId);
    if (conversation === undefined || snapshot === undefined) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, ConversationRuntimeContextSnapshotLink, {
      id: record.id,
      conversation,
      snapshot,
      role: record.role,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

function resolveHydratedConfigScope(
  scopeKind: NonNullable<ClientState['systemPromptScopeLinks'][number]>['scopeKind'],
  scopeId: string | undefined,
  maps: ConfigScopeHydrationMaps<'prompts' | 'profiles' | 'runtimeContexts'>
): { ok: true; data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity }> } | { ok: false } {
  switch (scopeKind) {
    case 'global': return { ok: true, data: {} };
    case 'conversation': {
      const conversation = scopeId ? maps.conversations.get(scopeId) : undefined;
      return conversation === undefined ? { ok: false } : { ok: true, data: { conversation } };
    }
    case 'agent': {
      const agent = scopeId ? maps.agents.get(scopeId) : undefined;
      return agent === undefined ? { ok: false } : { ok: true, data: { agent } };
    }
    case 'mode': {
      const mode = scopeId ? maps.modes.get(scopeId) : undefined;
      return mode === undefined ? { ok: false } : { ok: true, data: { mode } };
    }
    case 'run': {
      const run = scopeId ? maps.runs.get(scopeId) : undefined;
      return run === undefined ? { ok: false } : { ok: true, data: { run } };
    }
  }
}



interface ToolPolicyScopeHydrationMaps {
  agents: Map<string, Entity>;
  conversations: Map<string, Entity>;
  modes: Map<string, Entity>;
  toolPolicies: Map<string, Entity>;
  runs: Map<string, Entity>;
}

function hydrateToolPolicyScopeLinks(world: World, state: ClientState, maps: ToolPolicyScopeHydrationMaps): void {
  const existing = existingIds(world, ToolPolicyScopeLink);
  for (const record of state.toolPolicyScopeLinks ?? []) {
    if (existing.has(record.id)) continue;
    const toolPolicy = maps.toolPolicies.get(record.toolPolicyId);
    if (toolPolicy === undefined) continue;
    const scope = resolveHydratedToolPolicyScope(record.scopeKind, record.scopeId, maps);
    if (!scope.ok) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, ToolPolicyScopeLink, {
      id: record.id,
      scopeKind: record.scopeKind,
      ...(record.scopeId ? { scopeId: record.scopeId } : {}),
      toolPolicy,
      ...scope.data,
      role: record.role,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

interface SkillPolicyScopeHydrationMaps {
  agents: Map<string, Entity>;
  conversations: Map<string, Entity>;
  modes: Map<string, Entity>;
  skillPolicies: Map<string, Entity>;
  runs: Map<string, Entity>;
}

function hydrateSkillPolicyScopeLinks(world: World, state: ClientState, maps: SkillPolicyScopeHydrationMaps): void {
  const existing = existingIds(world, SkillPolicyScopeLink);
  for (const record of state.skillPolicyScopeLinks ?? []) {
    if (existing.has(record.id)) continue;
    const skillPolicy = maps.skillPolicies.get(record.skillPolicyId);
    if (skillPolicy === undefined) continue;
    const scope = resolveHydratedToolPolicyScope(record.scopeKind, record.scopeId, {
      agents: maps.agents,
      conversations: maps.conversations,
      modes: maps.modes,
      toolPolicies: maps.skillPolicies,
      runs: maps.runs
    });
    if (!scope.ok) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, SkillPolicyScopeLink, {
      id: record.id,
      scopeKind: record.scopeKind,
      ...(record.scopeId ? { scopeId: record.scopeId } : {}),
      skillPolicy,
      ...scope.data,
      role: record.role,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

function resolveHydratedToolPolicyScope(
  scopeKind: NonNullable<ClientState['toolPolicyScopeLinks'][number]>['scopeKind'],
  scopeId: string | undefined,
  maps: ToolPolicyScopeHydrationMaps
): { ok: true; data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity; agentSystemId: string }> } | { ok: false } {
  switch (scopeKind) {
    case 'global':
      return { ok: true, data: {} };
    case 'conversation': {
      const conversation = scopeId ? maps.conversations.get(scopeId) : undefined;
      return conversation === undefined ? { ok: false } : { ok: true, data: { conversation } };
    }
    case 'agent': {
      const agent = scopeId ? maps.agents.get(scopeId) : undefined;
      return agent === undefined ? { ok: false } : { ok: true, data: { agent } };
    }
    case 'mode': {
      const mode = scopeId ? maps.modes.get(scopeId) : undefined;
      return mode === undefined ? { ok: false } : { ok: true, data: { mode } };
    }
    case 'run': {
      const run = scopeId ? maps.runs.get(scopeId) : undefined;
      return run === undefined ? { ok: false } : { ok: true, data: { run } };
    }
    case 'agentSystem':
      return scopeId ? { ok: true, data: { agentSystemId: scopeId } } : { ok: false };
  }
}

interface WorkEnvironmentPolicyScopeHydrationMaps {
  conversations: Map<string, Entity>;
  agents: Map<string, Entity>;
  modes: Map<string, Entity>;
  runs: Map<string, Entity>;
  policies: Map<string, Entity>;
}

function hydrateWorkEnvironmentPolicyScopeLinks(world: World, state: ClientState, maps: WorkEnvironmentPolicyScopeHydrationMaps): void {
  const existing = existingIds(world, WorkEnvironmentPolicyScopeLink);
  for (const record of state.workEnvironmentPolicyScopeLinks ?? []) {
    if (existing.has(record.id)) continue;
    const policy = maps.policies.get(record.workEnvironmentPolicyId);
    if (policy === undefined) continue;
    const scope = resolveHydratedWorkEnvironmentPolicyScope(record.scopeKind, record.scopeId, maps);
    if (!scope.ok) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, WorkEnvironmentPolicyScopeLink, {
      id: record.id,
      scopeKind: record.scopeKind,
      ...(record.scopeId ? { scopeId: record.scopeId } : {}),
      policy,
      ...scope.data,
      role: record.role,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

function resolveHydratedWorkEnvironmentPolicyScope(
  scopeKind: NonNullable<ClientState['workEnvironmentPolicyScopeLinks'][number]>['scopeKind'],
  scopeId: string | undefined,
  maps: WorkEnvironmentPolicyScopeHydrationMaps
): { ok: true; data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity; agentSystemId: string }> } | { ok: false } {
  switch (scopeKind) {
    case 'global':
      return { ok: true, data: {} };
    case 'conversation': {
      const conversation = scopeId ? maps.conversations.get(scopeId) : undefined;
      return conversation === undefined ? { ok: false } : { ok: true, data: { conversation } };
    }
    case 'agent': {
      const agent = scopeId ? maps.agents.get(scopeId) : undefined;
      return agent === undefined ? { ok: false } : { ok: true, data: { agent } };
    }
    case 'mode': {
      const mode = scopeId ? maps.modes.get(scopeId) : undefined;
      return mode === undefined ? { ok: false } : { ok: true, data: { mode } };
    }
    case 'run': {
      const run = scopeId ? maps.runs.get(scopeId) : undefined;
      return run === undefined ? { ok: false } : { ok: true, data: { run } };
    }
    case 'agentSystem':
      return scopeId ? { ok: true, data: { agentSystemId: scopeId } } : { ok: false };
  }
}

interface CheckpointPolicyScopeHydrationMaps {
  conversations: Map<string, Entity>;
  agents: Map<string, Entity>;
  modes: Map<string, Entity>;
  runs: Map<string, Entity>;
  policies: Map<string, Entity>;
}

function hydrateCheckpointPolicyScopeLinks(world: World, state: ClientState, maps: CheckpointPolicyScopeHydrationMaps): void {
  const existing = existingIds(world, CheckpointPolicyScopeLink);
  for (const record of state.checkpointPolicyScopeLinks ?? []) {
    if (existing.has(record.id)) continue;
    const checkpointPolicy = maps.policies.get(record.checkpointPolicyId);
    if (checkpointPolicy === undefined) continue;
    const scope = resolveHydratedConfigScope(record.scopeKind, record.scopeId, {
      agents: maps.agents,
      conversations: maps.conversations,
      modes: maps.modes,
      runs: maps.runs
    });
    if (!scope.ok) continue;
    const entity = world.spawn();
    existing.add(record.id);
    world.add(entity, CheckpointPolicyScopeLink, {
      id: record.id,
      scopeKind: record.scopeKind,
      ...(record.scopeId ? { scopeId: record.scopeId } : {}),
      checkpointPolicy,
      ...scope.data,
      role: record.role,
      createdAt: record.createdAt || Date.now(),
      updatedAt: record.updatedAt || record.createdAt || Date.now()
    });
  }
}

interface CheckpointHydrationMaps {
  conversations: Map<string, Entity>;
  projectContexts: Map<string, Entity>;
  shadowRepositories: Map<string, Entity>;
  messages: Map<string, Entity>;
  runs: Map<string, Entity>;
  toolCalls: Map<string, Entity>;
}

function hydrateCheckpointRecords(world: World, state: ClientState, maps: CheckpointHydrationMaps): void {
  const repositoryLinkIds = existingIds(world, ConversationCheckpointRepositoryLink);
  for (const record of state.conversationCheckpointRepositoryLinks ?? []) {
    if (repositoryLinkIds.has(record.id)) continue;
    const conversation = maps.conversations.get(record.conversationId);
    const projectContext = maps.projectContexts.get(record.projectContextId);
    const shadowRepository = maps.shadowRepositories.get(record.shadowRepositoryId);
    if (conversation === undefined || projectContext === undefined || shadowRepository === undefined) continue;
    const entity = world.spawn();
    repositoryLinkIds.add(record.id);
    world.add(entity, ConversationCheckpointRepositoryLink, {
      id: record.id,
      conversation,
      projectContext,
      shadowRepository,
      projectUri: record.projectUri,
      projectDisplayPath: record.projectDisplayPath,
      role: record.role,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });
  }

  const checkpointEntities = existingRecords(world, Checkpoint);
  for (const record of state.checkpoints ?? []) {
    if (checkpointEntities.has(record.id)) continue;
    const conversation = maps.conversations.get(record.conversationId);
    const projectContext = maps.projectContexts.get(record.projectContextId);
    const shadowRepository = maps.shadowRepositories.get(record.shadowRepositoryId);
    if (conversation === undefined || projectContext === undefined || shadowRepository === undefined) continue;
    const entity = world.spawn();
    checkpointEntities.set(record.id, entity);
    world.add(entity, Checkpoint, {
      id: record.id,
      conversation,
      projectContext,
      shadowRepository,
      trigger: record.trigger,
      status: record.status,
      projectUri: record.projectUri,
      projectDisplayPath: record.projectDisplayPath,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.commitSha ? { commitSha: record.commitSha } : {}),
      ...(record.skipReason ? { skipReason: record.skipReason } : {}),
      ...(record.message ? { message: record.message } : {}),
      ...(record.fileCount !== undefined ? { fileCount: record.fileCount } : {}),
      ...(record.byteCount !== undefined ? { byteCount: record.byteCount } : {}),
      ...(record.emptyDirectoryCount !== undefined ? { emptyDirectoryCount: record.emptyDirectoryCount } : {})
    });
  }

  const anchorIds = existingIds(world, CheckpointTimelineAnchor);
  for (const record of state.checkpointTimelineAnchors ?? []) {
    if (anchorIds.has(record.id)) continue;
    const conversation = maps.conversations.get(record.conversationId);
    const checkpoint = checkpointEntities.get(record.checkpointId);
    const floorMessage = maps.messages.get(record.floorMessageId);
    if (conversation === undefined || checkpoint === undefined || floorMessage === undefined) continue;
    const entity = world.spawn();
    anchorIds.add(record.id);
    world.add(entity, CheckpointTimelineAnchor, {
      id: record.id,
      conversation,
      checkpoint,
      floorMessage,
      position: record.position,
      order: record.order,
      ...(record.sourceRunId ? { sourceRunId: record.sourceRunId } : {}),
      ...(record.sourceToolCallId ? { sourceToolCallId: record.sourceToolCallId } : {}),
      ...(record.sourceRunId && maps.runs.has(record.sourceRunId) ? { sourceRun: maps.runs.get(record.sourceRunId)! } : {}),
      ...(record.sourceToolCallId && maps.toolCalls.has(record.sourceToolCallId) ? { sourceToolCall: maps.toolCalls.get(record.sourceToolCallId)! } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });
  }
}


function spawnLink(world: World, left: Map<string, Entity>, right: Map<string, Entity>, record: any, component: { id: symbol }, leftKey: string, rightKey: string): void {
  if (existingIds(world, component).has(record.id)) return;
  const leftId = record[`${leftKey}Id`] as string | undefined;
  const rightId = record[`${rightKey}Id`] as string | undefined;
  if (!leftId || !rightId) return;
  const leftEntity = left.get(leftId);
  const rightEntity = right.get(rightId);
  if (leftEntity === undefined || rightEntity === undefined) return;
  const now = Date.now();
  const entity = world.spawn();
  world.add(entity, component as never, { id: record.id, [leftKey]: leftEntity, [rightKey]: rightEntity, role: record.role, createdAt: now, updatedAt: now } as never);
}

function spawnRunLink(world: World, left: Map<string, Entity>, right: Map<string, Entity>, record: any, component: { id: symbol }, leftKey: string, rightKey: string): void {
  if (existingIds(world, component).has(record.id)) return;
  const leftId = record[`${leftKey}Id`] as string | undefined;
  const rightId = record[`${rightKey}Id`] as string | undefined;
  if (!leftId || !rightId) return;
  const leftEntity = left.get(leftId);
  const rightEntity = right.get(rightId);
  if (leftEntity === undefined || rightEntity === undefined) return;
  const now = Date.now();
  const entity = world.spawn();
  world.add(entity, component as never, { id: record.id, [leftKey]: leftEntity, [rightKey]: rightEntity, role: record.role, createdAt: now, updatedAt: now } as never);
}
