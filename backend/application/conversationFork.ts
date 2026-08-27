import type { ComponentType, Entity, World } from '../ecs/types';
import {
  Agent,
  AgentConversationLink,
  ConversationAgentSelection,
  type AgentConversationLinkData
} from '../world/modules/agent/components';
import {
  Conversation,
  ConversationBranchLink,
  ConversationFullContextLoaded,
  ConversationOriginLink,
  Message,
  MessageCurrentRevisionLink,
  MessageRevision,
  PartOf,
  type MessageData,
  type MessageRevisionData
} from '../world/modules/chat/components';
import { rememberHydratedMessageSeq } from '../world/modules/chat/bundles';
import {
  CompressionBlock,
  CompressionBlockSourceLink,
  CompressionContextVariant,
  type CompressionBlockData
} from '../world/modules/compression/components';
import {
  ConversationWorkflowSelection,
  ModelProfile,
  ModelProfileScopeLink,
  SystemPrompt,
  SystemPromptScopeLink,
  ToolPolicy,
  Workflow,
  type ConversationWorkflowSelectionData
} from '../world/modules/workflow/components';
import { ConversationProjectLink } from '../world/modules/project/components';
import {
  ToolCall,
  ToolCallEvent,
  ToolPolicyScopeLink,
  ToolResultConsumed,
  ToolState
} from '../world/modules/tools/components';
import { SkillPolicy, SkillPolicyScopeLink } from '../world/modules/skill/components';
import {
  ConversationRuntimeContextSnapshotLink,
  RuntimeContext,
  RuntimeContextScopeLink,
  RuntimeContextSnapshot,
  type ConversationRuntimeContextSnapshotLinkData
} from '../world/modules/runtimeContext/components';
import { PlanReviewPolicy, PlanReviewPolicyScopeLink } from '../world/modules/plan/components';
import {
  Checkpoint,
  CheckpointPolicy,
  CheckpointPolicyScopeLink,
  CheckpointTimelineAnchor,
  ConversationCheckpointRepositoryLink,
  ShadowRepository
} from '../world/modules/checkpoint/components';
import {
  ConversationWorkEnvironmentLink,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink
} from '../world/modules/workEnvironment/components';
import {
  TERMINAL_TOOL_CALL_STATUSES,
  isFunctionCallPart,
  isFunctionResponsePart
} from '../../shared/protocol';
import { createStableId } from '../utils/stableId';

export interface ForkConversationInWorldInput {
  sourceConversationId: string;
  throughMessageId: string;
  targetConversationId: string;
  now?: number;
}

export interface ForkConversationInWorldResult {
  conversationId: string;
  conversation: Entity;
  sourceConversation: Entity;
  sourceMessage: Entity;
  copiedMessageCount: number;
}

/**
 * 在 ECS 中创建一条独立的分支对话。
 *
 * 这里只组合领域对象与 Link，不负责加载源对话、保存设置或打开 UI。调用方必须先确保
 * source conversation 已完整 hydrate；持久化仍由 ClientStatePersistence 的投影负责。
 */
export function forkConversationInWorld(world: World, input: ForkConversationInWorldInput): ForkConversationInWorldResult {
  const sourceConversationId = input.sourceConversationId.trim();
  const throughMessageId = input.throughMessageId.trim();
  const targetConversationId = input.targetConversationId.trim();
  if (!sourceConversationId || !throughMessageId || !targetConversationId) {
    throw new Error('分支对话缺少源对话、目标消息或新对话 ID。');
  }
  if (sourceConversationId === targetConversationId) {
    throw new Error('分支对话必须使用新的对话 ID。');
  }
  if (findConversation(world, targetConversationId) !== undefined) {
    throw new Error(`对话 ID 已存在：${targetConversationId}`);
  }

  const sourceConversation = findConversation(world, sourceConversationId);
  if (sourceConversation === undefined) throw new Error('找不到要复制的源对话。');
  const sourceConversationData = world.get(sourceConversation, Conversation)!;
  const sourceMessages = messagesForConversation(world, sourceConversation);
  const sourceMessageIndex = sourceMessages.findIndex((entity) => world.get(entity, Message)?.id === throughMessageId);
  if (sourceMessageIndex < 0) throw new Error('找不到要复制到的目标消息。');

  const sourceMessage = sourceMessages[sourceMessageIndex]!;
  const messagesToCopy = messagesThroughFloor(world, sourceMessages, sourceMessageIndex);
  const agentContext = resolveAgentContext(world, sourceConversation);
  if (!agentContext) throw new Error('源对话没有可继承的 Agent 关系。');

  const now = input.now ?? Date.now();
  const conversation = world.spawn();
  world.add(conversation, Conversation, {
    id: targetConversationId,
    ...(sourceConversationData.title !== undefined ? { title: sourceConversationData.title } : {}),
    visibility: 'visible'
  });
  world.add(conversation, ConversationFullContextLoaded, { loadedAt: now });

  const messageMap = cloneMessages(world, messagesToCopy, conversation);
  const revisionIdMap = cloneMessageRevisions(world, messagesToCopy, messageMap);
  const toolCallMap = cloneToolSnapshots(world, messageMap, now);
  cloneCompressionHistory(world, sourceConversation, conversation, messagesToCopy, messageMap, revisionIdMap);
  cloneAgentRelations(world, conversation, targetConversationId, agentContext, now);
  cloneWorkflowSelection(world, sourceConversation, conversation, targetConversationId, now);
  cloneProjectLinks(world, sourceConversation, conversation, now);
  cloneWorkEnvironmentLinks(world, sourceConversation, conversation, now);
  const scopedConfiguration = cloneConversationScopedConfiguration(
    world,
    sourceConversation,
    sourceConversationId,
    conversation,
    targetConversationId,
    now
  );
  cloneRuntimeContextSnapshot(world, sourceConversation, conversation, targetConversationId, scopedConfiguration.runtimeContextMap, now);
  cloneCheckpointHistory(world, sourceConversation, conversation, messagesToCopy, messageMap, toolCallMap, now);

  const sourceRevision = currentRevisionForMessage(world, sourceMessage);
  const branch = world.spawn();
  world.add(branch, ConversationBranchLink, {
    id: createStableId('cbl'),
    sourceConversation,
    targetConversation: conversation,
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    kind: 'fork',
    createdAt: now,
    updatedAt: now
  });

  const origin = world.spawn();
  world.add(origin, ConversationOriginLink, {
    id: createStableId('col'),
    conversation,
    originKind: 'user',
    sourceKind: 'user',
    createdAt: now,
    updatedAt: now
  });

  return {
    conversationId: targetConversationId,
    conversation,
    sourceConversation,
    sourceMessage,
    copiedMessageCount: messagesToCopy.length
  };
}

function resolveAgentContext(world: World, sourceConversation: Entity): { selectedAgent: Entity; links: AgentConversationLinkData[] } | undefined {
  const links = world.query(AgentConversationLink)
    .map((entity) => world.get(entity, AgentConversationLink))
    .filter((link): link is AgentConversationLinkData => !!link && link.conversation === sourceConversation)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id));

  let selectedAgent: Entity | undefined;
  let selectedAt = Number.NEGATIVE_INFINITY;
  let selectedEntity = Number.NEGATIVE_INFINITY;
  for (const entity of world.query(ConversationAgentSelection)) {
    const data = world.get(entity, ConversationAgentSelection);
    if (!data || data.conversation !== sourceConversation || data.role !== 'active') continue;
    if (data.updatedAt > selectedAt || (data.updatedAt === selectedAt && entity > selectedEntity)) {
      selectedAgent = data.agent;
      selectedAt = data.updatedAt;
      selectedEntity = entity;
    }
  }

  selectedAgent ??= links.find((link) => link.role === 'default')?.agent ?? links[0]?.agent;
  if (selectedAgent === undefined || !world.has(selectedAgent, Agent)) return undefined;
  return { selectedAgent, links };
}

function cloneMessages(
  world: World,
  sourceMessages: readonly Entity[],
  targetConversation: Entity
): Map<Entity, Entity> {
  const messageMap = new Map<Entity, Entity>();
  let maxSeq = 0;
  for (const sourceEntity of sourceMessages) {
    const source = world.get(sourceEntity, Message);
    if (!source) continue;
    const targetEntity = world.spawn();
    const targetStatus = source.status === 'streaming' ? 'error' : source.status;
    world.add(targetEntity, Message, {
      ...clonePlainData(source),
      id: createStableId('msg'),
      content: clonePlainData(source.content),
      status: targetStatus,
      ...(source.status === 'streaming' && source.stopReason === undefined ? { stopReason: 'stale' as const } : {})
    });
    world.add(targetEntity, PartOf, { parent: targetConversation });
    messageMap.set(sourceEntity, targetEntity);
    maxSeq = Math.max(maxSeq, source.seq);
  }
  rememberHydratedMessageSeq(targetConversation, maxSeq);
  if (messageMap.size === 0) throw new Error('源对话在目标位置之前没有可复制的消息。');
  return messageMap;
}

function cloneMessageRevisions(world: World, sourceMessages: readonly Entity[], messageMap: ReadonlyMap<Entity, Entity>): Map<string, string> {
  const sourceMessageSet = new Set(sourceMessages);
  const revisionMap = new Map<Entity, Entity>();
  const revisionIdMap = new Map<string, string>();
  const revisionsByMessage = new Map<Entity, Entity[]>();

  const sourceRevisions = world.query(MessageRevision, PartOf)
    .map((entity) => ({ entity, parent: world.get(entity, PartOf)?.parent, data: world.get(entity, MessageRevision) }))
    .filter((item): item is { entity: Entity; parent: Entity; data: MessageRevisionData } =>
      item.parent !== undefined && sourceMessageSet.has(item.parent) && item.data !== undefined
    )
    .sort((left, right) => left.data.createdAt - right.data.createdAt || left.entity - right.entity);

  for (const sourceRevision of sourceRevisions) {
    const targetMessage = messageMap.get(sourceRevision.parent);
    if (targetMessage === undefined) continue;
    const targetRevision = world.spawn();
    const targetRevisionId = createStableId('rev');
    world.add(targetRevision, MessageRevision, {
      ...clonePlainData(sourceRevision.data),
      id: targetRevisionId,
      content: clonePlainData(sourceRevision.data.content)
    });
    world.add(targetRevision, PartOf, { parent: targetMessage });
    revisionMap.set(sourceRevision.entity, targetRevision);
    revisionIdMap.set(sourceRevision.data.id, targetRevisionId);
    const revisions = revisionsByMessage.get(sourceRevision.parent) ?? [];
    revisions.push(targetRevision);
    revisionsByMessage.set(sourceRevision.parent, revisions);
  }

  for (const sourceMessage of sourceMessages) {
    const targetMessage = messageMap.get(sourceMessage);
    const message = world.get(sourceMessage, Message);
    if (targetMessage === undefined || !message) continue;
    const sourceCurrentRevision = currentRevisionForMessage(world, sourceMessage);
    let targetRevision = sourceCurrentRevision !== undefined ? revisionMap.get(sourceCurrentRevision) : undefined;
    const clonedRevisions = revisionsByMessage.get(sourceMessage);
    targetRevision ??= clonedRevisions?.[clonedRevisions.length - 1];
    if (targetRevision === undefined) {
      targetRevision = world.spawn();
      world.add(targetRevision, MessageRevision, {
        id: createStableId('rev'),
        content: clonePlainData(message.content),
        createdAt: message.createdAt,
        reason: 'created'
      });
      world.add(targetRevision, PartOf, { parent: targetMessage });
    }
    const targetLink = world.spawn();
    world.add(targetLink, MessageCurrentRevisionLink, {
      id: createStableId('mcr'),
      message: targetMessage,
      revision: targetRevision
    });
  }
  return revisionIdMap;
}

function cloneCompressionHistory(
  world: World,
  sourceConversation: Entity,
  targetConversation: Entity,
  sourceMessages: readonly Entity[],
  messageMap: ReadonlyMap<Entity, Entity>,
  revisionIdMap: ReadonlyMap<string, string>
): void {
  const targetMessageBySourceId = new Map<string, Entity>();
  const targetMessageIdBySourceId = new Map<string, string>();
  let maxCopiedSeq = Number.NEGATIVE_INFINITY;
  for (const sourceMessage of sourceMessages) {
    const source = world.get(sourceMessage, Message);
    const targetMessage = messageMap.get(sourceMessage);
    const target = targetMessage !== undefined ? world.get(targetMessage, Message) : undefined;
    if (!source || targetMessage === undefined || !target) continue;
    targetMessageBySourceId.set(source.id, targetMessage);
    targetMessageIdBySourceId.set(source.id, target.id);
    maxCopiedSeq = Math.max(maxCopiedSeq, source.seq);
  }
  if (!Number.isFinite(maxCopiedSeq)) return;

  const sourceBlocks = world.query(CompressionBlock)
    .map((entity) => ({ entity, data: world.get(entity, CompressionBlock) }))
    .filter((item): item is { entity: Entity; data: CompressionBlockData } => {
      const boundarySeq = item.data?.endSeq ?? item.data?.anchorSeq;
      return item.data !== undefined
        && item.data.conversation === sourceConversation
        && item.data.status !== 'pending'
        && item.data.status !== 'running'
        && boundarySeq !== undefined
        && boundarySeq <= maxCopiedSeq;
    })
    .sort((left, right) => {
      const leftSeq = left.data.endSeq ?? left.data.anchorSeq ?? 0;
      const rightSeq = right.data.endSeq ?? right.data.anchorSeq ?? 0;
      return leftSeq - rightSeq || left.data.createdAt - right.data.createdAt || left.data.id.localeCompare(right.data.id);
    });

  const sourceBlockById = new Map(sourceBlocks.map((item) => [item.data.id, item.entity]));
  const blockMap = new Map<Entity, Entity>();
  for (const sourceBlock of sourceBlocks) {
    const targetAnchorMessageId = sourceBlock.data.anchorMessageId
      ? targetMessageIdBySourceId.get(sourceBlock.data.anchorMessageId)
      : undefined;
    if (sourceBlock.data.anchorMessageId && !targetAnchorMessageId) continue;

    const targetBlock = world.spawn();
    const cloned = clonePlainData(sourceBlock.data);
    const {
      id: _id,
      conversation: _conversation,
      anchorMessageId: _anchorMessageId,
      ...rest
    } = cloned;
    world.add(targetBlock, CompressionBlock, {
      ...rest,
      id: createStableId('compression-block'),
      conversation: targetConversation,
      ...(targetAnchorMessageId ? { anchorMessageId: targetAnchorMessageId } : {})
    });
    blockMap.set(sourceBlock.entity, targetBlock);
  }

  for (const sourceLinkEntity of world.query(CompressionBlockSourceLink)) {
    const sourceLink = world.get(sourceLinkEntity, CompressionBlockSourceLink);
    const targetBlock = sourceLink ? blockMap.get(sourceLink.block) : undefined;
    if (!sourceLink || targetBlock === undefined) continue;

    let targetSource: Entity | undefined;
    let targetSourceId: string | undefined;
    let targetRevisionId: string | undefined;
    if (sourceLink.sourceKind === 'message') {
      const sourceMessage = sourceLink.source !== undefined && messageMap.has(sourceLink.source)
        ? sourceLink.source
        : targetMessageBySourceId.has(sourceLink.sourceId)
          ? sourceMessages.find((entity) => world.get(entity, Message)?.id === sourceLink.sourceId)
          : undefined;
      targetSource = sourceMessage !== undefined ? messageMap.get(sourceMessage) : undefined;
      targetSourceId = targetSource !== undefined ? world.get(targetSource, Message)?.id : undefined;
      targetRevisionId = sourceLink.revisionId ? revisionIdMap.get(sourceLink.revisionId) : undefined;
      if (sourceLink.revisionId && !targetRevisionId) continue;
    } else {
      const sourceBlock = sourceLink.source !== undefined && blockMap.has(sourceLink.source)
        ? sourceLink.source
        : sourceBlockById.get(sourceLink.sourceId);
      targetSource = sourceBlock !== undefined ? blockMap.get(sourceBlock) : undefined;
      targetSourceId = targetSource !== undefined ? world.get(targetSource, CompressionBlock)?.id : undefined;
    }
    if (targetSource === undefined || !targetSourceId) continue;

    const targetLink = world.spawn();
    const cloned = clonePlainData(sourceLink);
    const {
      id: _id,
      block: _block,
      source: _source,
      sourceId: _sourceId,
      revisionId: _revisionId,
      ...rest
    } = cloned;
    world.add(targetLink, CompressionBlockSourceLink, {
      ...rest,
      id: createStableId('compression-source'),
      block: targetBlock,
      source: targetSource,
      sourceId: targetSourceId,
      ...(targetRevisionId ? { revisionId: targetRevisionId } : {})
    });
  }

  for (const sourceVariantEntity of world.query(CompressionContextVariant)) {
    const sourceVariant = world.get(sourceVariantEntity, CompressionContextVariant);
    const targetBlock = sourceVariant ? blockMap.get(sourceVariant.block) : undefined;
    if (!sourceVariant || targetBlock === undefined) continue;
    const targetVariant = world.spawn();
    const cloned = clonePlainData(sourceVariant);
    const { id: _id, block: _block, ...rest } = cloned;
    world.add(targetVariant, CompressionContextVariant, {
      ...rest,
      id: createStableId('compression-variant'),
      block: targetBlock
    });
  }
}

type ToolCallCloneMap = Map<Entity, { entity: Entity; id: string }>;

function cloneToolSnapshots(world: World, messageMap: ReadonlyMap<Entity, Entity>, now: number): ToolCallCloneMap {
  const toolCallMap: ToolCallCloneMap = new Map();
  for (const sourceEntity of world.query(ToolCall, ToolState, PartOf)) {
    const sourceMessage = world.get(sourceEntity, PartOf)?.parent;
    const targetMessage = sourceMessage !== undefined ? messageMap.get(sourceMessage) : undefined;
    const call = world.get(sourceEntity, ToolCall);
    const state = world.get(sourceEntity, ToolState);
    if (targetMessage === undefined || !call || !state) continue;

    const targetEntity = world.spawn();
    const id = createStableId('tc');
    const sourceMessageData = sourceMessage !== undefined ? world.get(sourceMessage, Message) : undefined;
    world.add(targetEntity, ToolCall, {
      ...clonePlainData(call),
      id,
      functionCallId: functionCallIdForClone(call.id, call.functionCallId, sourceMessageData)
    });
    world.add(targetEntity, PartOf, { parent: targetMessage });
    const targetState = clonePlainData(state);
    if (!TERMINAL_TOOL_CALL_STATUSES.has(targetState.status)) {
      targetState.status = 'error';
      targetState.updatedAt = now;
      targetState.error = targetState.error ?? '分支复制时原工具调用尚未结束，已作为历史记录停止。';
      delete targetState.progress;
    }
    world.add(targetEntity, ToolState, targetState);
    world.add(targetEntity, ToolResultConsumed, true);
    toolCallMap.set(sourceEntity, { entity: targetEntity, id });
  }

  for (const sourceEventEntity of world.query(ToolCallEvent, PartOf)) {
    const sourceToolCall = world.get(sourceEventEntity, PartOf)?.parent;
    const targetToolCall = sourceToolCall !== undefined ? toolCallMap.get(sourceToolCall) : undefined;
    const event = world.get(sourceEventEntity, ToolCallEvent);
    if (!targetToolCall || !event) continue;
    const targetEvent = world.spawn();
    world.add(targetEvent, ToolCallEvent, {
      ...clonePlainData(event),
      id: createStableId('tce'),
      toolCallId: targetToolCall.id
    });
    world.add(targetEvent, PartOf, { parent: targetToolCall.entity });
  }
  return toolCallMap;
}

function functionCallIdForClone(callId: string, functionCallId: string | undefined, sourceMessage: MessageData | undefined): string {
  const partIds = new Set((sourceMessage?.content.parts ?? [])
    .filter(isFunctionCallPart)
    .map((part) => part.id)
    .filter((id): id is string => !!id));
  if (functionCallId && partIds.has(functionCallId)) return functionCallId;
  if (partIds.has(callId)) return callId;
  return functionCallId ?? callId;
}

function cloneAgentRelations(
  world: World,
  targetConversation: Entity,
  targetConversationId: string,
  context: { selectedAgent: Entity; links: AgentConversationLinkData[] },
  now: number
): void {
  const linkedAgents = new Set<Entity>();
  for (const source of context.links) {
    if (!world.has(source.agent, Agent)) continue;
    const targetLink = world.spawn();
    world.add(targetLink, AgentConversationLink, {
      id: createStableId('acl'),
      agent: source.agent,
      conversation: targetConversation,
      role: source.role,
      createdAt: now,
      updatedAt: now
    });
    linkedAgents.add(source.agent);
  }
  if (!linkedAgents.has(context.selectedAgent)) {
    const targetLink = world.spawn();
    world.add(targetLink, AgentConversationLink, {
      id: createStableId('acl'),
      agent: context.selectedAgent,
      conversation: targetConversation,
      role: 'default',
      createdAt: now,
      updatedAt: now
    });
  }

  const agent = world.get(context.selectedAgent, Agent)!;
  const selection = world.spawn();
  world.add(selection, ConversationAgentSelection, {
    id: `conversation-agent:${targetConversationId}:${agent.id}`,
    conversation: targetConversation,
    agent: context.selectedAgent,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
}

function cloneWorkflowSelection(world: World, sourceConversation: Entity, targetConversation: Entity, targetConversationId: string, now: number): void {
  const selected = world.query(ConversationWorkflowSelection)
    .map((entity) => ({ entity, data: world.get(entity, ConversationWorkflowSelection) }))
    .filter((item): item is { entity: Entity; data: ConversationWorkflowSelectionData } =>
      item.data !== undefined && item.data.conversation === sourceConversation && item.data.role === 'active'
    )
    .sort((left, right) => right.data.updatedAt - left.data.updatedAt || right.entity - left.entity)[0];
  if (!selected) return;
  const selectedWorkflow = selected.data.scopeKind === 'workflow'
    && selected.data.workflow !== undefined
    && world.has(selected.data.workflow, Workflow)
    ? selected.data.workflow
    : undefined;
  const workflowId = selectedWorkflow !== undefined ? world.get(selectedWorkflow, Workflow)?.id : undefined;
  const entity = world.spawn();
  world.add(entity, ConversationWorkflowSelection, {
    id: selectedWorkflow !== undefined && workflowId
      ? `conversation-workflow:workflow:${targetConversationId}:${workflowId}`
      : `conversation-workflow:global:${targetConversationId}`,
    conversation: targetConversation,
    scopeKind: selectedWorkflow !== undefined ? 'workflow' : 'global',
    ...(selectedWorkflow !== undefined ? { workflow: selectedWorkflow } : {}),
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
}

function cloneProjectLinks(world: World, sourceConversation: Entity, targetConversation: Entity, now: number): void {
  for (const entity of world.query(ConversationProjectLink)) {
    const source = world.get(entity, ConversationProjectLink);
    if (!source || source.conversation !== sourceConversation) continue;
    const target = world.spawn();
    world.add(target, ConversationProjectLink, {
      id: createStableId('cpl'),
      conversation: targetConversation,
      projectContext: source.projectContext,
      role: source.role,
      createdAt: now,
      updatedAt: now
    });
  }
}

function cloneWorkEnvironmentLinks(world: World, sourceConversation: Entity, targetConversation: Entity, now: number): void {
  for (const entity of world.query(ConversationWorkEnvironmentLink)) {
    const source = world.get(entity, ConversationWorkEnvironmentLink);
    if (!source || source.conversation !== sourceConversation) continue;
    const target = world.spawn();
    world.add(target, ConversationWorkEnvironmentLink, {
      id: createStableId('cwel'),
      conversation: targetConversation,
      workEnvironment: source.workEnvironment,
      role: source.role,
      createdAt: now,
      updatedAt: now
    });
  }
}

interface ScopedConfigurationCloneResult {
  runtimeContextMap: Map<Entity, Entity>;
}

interface ConversationScopeLinkBase {
  scopeKind: string;
  scopeId?: string;
  conversation?: Entity;
  role: string;
  createdAt: number;
  updatedAt: number;
}

function cloneConversationScopedConfiguration(
  world: World,
  sourceConversation: Entity,
  sourceConversationId: string,
  targetConversation: Entity,
  targetConversationId: string,
  now: number
): ScopedConfigurationCloneResult {
  const runtimeContextMap = new Map<Entity, Entity>();
  cloneConversationSystemPrompt(world, sourceConversation, sourceConversationId, targetConversation, targetConversationId, now);
  cloneConversationModelProfile(world, sourceConversation, sourceConversationId, targetConversation, targetConversationId, now);
  cloneConversationRuntimeContext(world, sourceConversation, sourceConversationId, targetConversation, targetConversationId, runtimeContextMap, now);
  cloneConversationToolPolicy(world, sourceConversation, sourceConversationId, targetConversation, targetConversationId, now);
  cloneConversationSkillPolicy(world, sourceConversation, sourceConversationId, targetConversation, targetConversationId, now);
  cloneConversationPlanReviewPolicy(world, sourceConversation, sourceConversationId, targetConversation, targetConversationId, now);
  cloneConversationWorkEnvironmentPolicy(world, sourceConversation, sourceConversationId, targetConversation, targetConversationId, now);
  cloneConversationCheckpointPolicy(world, sourceConversation, sourceConversationId, targetConversation, targetConversationId, now);
  return { runtimeContextMap };
}

function cloneConversationSystemPrompt(
  world: World,
  sourceConversation: Entity,
  sourceConversationId: string,
  targetConversation: Entity,
  targetConversationId: string,
  now: number
): void {
  const source = latestConversationScopeLink(world, SystemPromptScopeLink, sourceConversation, sourceConversationId);
  if (!source) return;
  const prompt = cloneOwnedScopedRecord(
    world,
    SystemPrompt,
    source.systemPrompt,
    `system-prompt:conversation:${sourceConversationId}`,
    `system-prompt:conversation:${targetConversationId}`
  );
  if (prompt === undefined) return;
  const entity = world.spawn();
  world.add(entity, SystemPromptScopeLink, {
    id: `system-prompt-scope:conversation:${targetConversationId}`,
    scopeKind: 'conversation',
    scopeId: targetConversationId,
    systemPrompt: prompt,
    conversation: targetConversation,
    role: source.role,
    ...(source.order !== undefined ? { order: source.order } : {}),
    createdAt: now,
    updatedAt: now
  });
}

function cloneConversationModelProfile(
  world: World,
  sourceConversation: Entity,
  sourceConversationId: string,
  targetConversation: Entity,
  targetConversationId: string,
  now: number
): void {
  const source = latestConversationScopeLink(world, ModelProfileScopeLink, sourceConversation, sourceConversationId);
  if (!source) return;
  const profile = cloneOwnedScopedRecord(
    world,
    ModelProfile,
    source.modelProfile,
    `model-profile:conversation:${sourceConversationId}`,
    `model-profile:conversation:${targetConversationId}`
  );
  if (profile === undefined) return;
  const entity = world.spawn();
  world.add(entity, ModelProfileScopeLink, {
    id: `model-profile-scope:conversation:${targetConversationId}`,
    scopeKind: 'conversation',
    scopeId: targetConversationId,
    modelProfile: profile,
    conversation: targetConversation,
    role: source.role,
    createdAt: now,
    updatedAt: now
  });
}

function cloneConversationRuntimeContext(
  world: World,
  sourceConversation: Entity,
  sourceConversationId: string,
  targetConversation: Entity,
  targetConversationId: string,
  runtimeContextMap: Map<Entity, Entity>,
  now: number
): void {
  const source = latestConversationScopeLink(world, RuntimeContextScopeLink, sourceConversation, sourceConversationId);
  if (!source) return;
  const context = cloneOwnedScopedRecord(
    world,
    RuntimeContext,
    source.runtimeContext,
    `runtime-context:conversation:${sourceConversationId}`,
    `runtime-context:conversation:${targetConversationId}`
  );
  if (context === undefined) return;
  runtimeContextMap.set(source.runtimeContext, context);
  const entity = world.spawn();
  world.add(entity, RuntimeContextScopeLink, {
    id: `runtime-context-scope:conversation:${targetConversationId}`,
    scopeKind: 'conversation',
    scopeId: targetConversationId,
    runtimeContext: context,
    conversation: targetConversation,
    role: source.role,
    ...(source.order !== undefined ? { order: source.order } : {}),
    createdAt: now,
    updatedAt: now
  });
}

function cloneConversationToolPolicy(
  world: World,
  sourceConversation: Entity,
  sourceConversationId: string,
  targetConversation: Entity,
  targetConversationId: string,
  now: number
): void {
  const source = latestConversationScopeLink(world, ToolPolicyScopeLink, sourceConversation, sourceConversationId);
  if (!source) return;
  const policy = cloneOwnedScopedRecord(
    world,
    ToolPolicy,
    source.toolPolicy,
    `tool-policy:conversation:${sourceConversationId}`,
    `tool-policy:conversation:${targetConversationId}`
  );
  if (policy === undefined) return;
  const entity = world.spawn();
  world.add(entity, ToolPolicyScopeLink, {
    id: `tool-policy-scope:conversation:${targetConversationId}`,
    scopeKind: 'conversation',
    scopeId: targetConversationId,
    toolPolicy: policy,
    conversation: targetConversation,
    role: source.role,
    createdAt: now,
    updatedAt: now
  });
}

function cloneConversationSkillPolicy(
  world: World,
  sourceConversation: Entity,
  sourceConversationId: string,
  targetConversation: Entity,
  targetConversationId: string,
  now: number
): void {
  const source = latestConversationScopeLink(world, SkillPolicyScopeLink, sourceConversation, sourceConversationId);
  if (!source) return;
  const policy = cloneOwnedScopedRecord(
    world,
    SkillPolicy,
    source.skillPolicy,
    `skill-policy:conversation:${sourceConversationId}`,
    `skill-policy:conversation:${targetConversationId}`
  );
  if (policy === undefined) return;
  const entity = world.spawn();
  world.add(entity, SkillPolicyScopeLink, {
    id: `skill-policy-scope:conversation:${targetConversationId}`,
    scopeKind: 'conversation',
    scopeId: targetConversationId,
    skillPolicy: policy,
    conversation: targetConversation,
    role: source.role,
    createdAt: now,
    updatedAt: now
  });
}

function cloneConversationPlanReviewPolicy(
  world: World,
  sourceConversation: Entity,
  sourceConversationId: string,
  targetConversation: Entity,
  targetConversationId: string,
  now: number
): void {
  const source = latestConversationScopeLink(world, PlanReviewPolicyScopeLink, sourceConversation, sourceConversationId);
  if (!source) return;
  const policy = cloneOwnedScopedRecord(
    world,
    PlanReviewPolicy,
    source.planReviewPolicy,
    `plan-review-policy:conversation:${sourceConversationId}`,
    `plan-review-policy:conversation:${targetConversationId}`
  );
  if (policy === undefined) return;
  const entity = world.spawn();
  world.add(entity, PlanReviewPolicyScopeLink, {
    id: `plan-review-policy-link:conversation:${targetConversationId}`,
    scopeKind: 'conversation',
    scopeId: targetConversationId,
    planReviewPolicy: policy,
    conversation: targetConversation,
    role: source.role,
    createdAt: now,
    updatedAt: now
  });
}

function cloneConversationWorkEnvironmentPolicy(
  world: World,
  sourceConversation: Entity,
  sourceConversationId: string,
  targetConversation: Entity,
  targetConversationId: string,
  now: number
): void {
  const source = latestConversationScopeLink(world, WorkEnvironmentPolicyScopeLink, sourceConversation, sourceConversationId);
  if (!source) return;
  const policy = cloneOwnedScopedRecord(
    world,
    WorkEnvironmentPolicy,
    source.policy,
    `work-environment-policy:conversation:${sourceConversationId}`,
    `work-environment-policy:conversation:${targetConversationId}`
  );
  if (policy === undefined) return;
  const entity = world.spawn();
  world.add(entity, WorkEnvironmentPolicyScopeLink, {
    id: `work-environment-policy-scope:conversation:${targetConversationId}`,
    scopeKind: 'conversation',
    scopeId: targetConversationId,
    policy,
    conversation: targetConversation,
    role: source.role,
    createdAt: now,
    updatedAt: now
  });
}

function cloneConversationCheckpointPolicy(
  world: World,
  sourceConversation: Entity,
  sourceConversationId: string,
  targetConversation: Entity,
  targetConversationId: string,
  now: number
): void {
  const source = latestConversationScopeLink(world, CheckpointPolicyScopeLink, sourceConversation, sourceConversationId);
  if (!source) return;
  const policy = cloneOwnedScopedRecord(
    world,
    CheckpointPolicy,
    source.checkpointPolicy,
    `checkpoint-policy:conversation:${sourceConversationId}`,
    `checkpoint-policy:conversation:${targetConversationId}`
  );
  if (policy === undefined) return;
  const entity = world.spawn();
  world.add(entity, CheckpointPolicyScopeLink, {
    id: `checkpoint-policy-scope:conversation:${targetConversationId}`,
    scopeKind: 'conversation',
    scopeId: targetConversationId,
    checkpointPolicy: policy,
    conversation: targetConversation,
    role: source.role,
    createdAt: now,
    updatedAt: now
  });
}

function latestConversationScopeLink<T extends ConversationScopeLinkBase>(
  world: World,
  component: ComponentType<T>,
  sourceConversation: Entity,
  sourceConversationId: string
): T | undefined {
  return world.query(component)
    .map((entity) => ({ entity, data: world.get(entity, component) }))
    .filter((item): item is { entity: Entity; data: T } => !!item.data
      && item.data.role === 'active'
      && item.data.scopeKind === 'conversation'
      && (item.data.conversation === sourceConversation || item.data.scopeId === sourceConversationId))
    .sort((left, right) => right.data.updatedAt - left.data.updatedAt || right.data.createdAt - left.data.createdAt || right.entity - left.entity)[0]?.data;
}

function cloneOwnedScopedRecord<T extends { id: string }>(
  world: World,
  component: ComponentType<T>,
  sourceEntity: Entity,
  sourceOwnedId: string,
  targetOwnedId: string
): Entity | undefined {
  const source = world.get(sourceEntity, component);
  if (!source) return undefined;
  if (source.id !== sourceOwnedId) return sourceEntity;
  const target = world.spawn();
  world.add(target, component, { ...clonePlainData(source), id: targetOwnedId } as T);
  return target;
}

function cloneRuntimeContextSnapshot(
  world: World,
  sourceConversation: Entity,
  targetConversation: Entity,
  targetConversationId: string,
  runtimeContextMap: ReadonlyMap<Entity, Entity>,
  now: number
): void {
  const sourceLink = world.query(ConversationRuntimeContextSnapshotLink)
    .map((entity) => ({ entity, data: world.get(entity, ConversationRuntimeContextSnapshotLink) }))
    .filter((item): item is { entity: Entity; data: ConversationRuntimeContextSnapshotLinkData } =>
      !!item.data && item.data.conversation === sourceConversation && item.data.role === 'active'
    )
    .sort((left, right) => right.data.updatedAt - left.data.updatedAt || right.data.createdAt - left.data.createdAt || right.entity - left.entity)[0]?.data;
  if (!sourceLink) return;
  const sourceSnapshot = world.get(sourceLink.snapshot, RuntimeContextSnapshot);
  if (!sourceSnapshot) return;
  const targetSnapshot = world.spawn();
  const cloned = clonePlainData(sourceSnapshot);
  const {
    id: _id,
    conversation: _conversation,
    sourceRuntimeContexts: _sourceRuntimeContexts,
    ...rest
  } = cloned;
  const sourceRuntimeContexts = sourceSnapshot.sourceRuntimeContexts?.map((entity) => runtimeContextMap.get(entity) ?? entity);
  world.add(targetSnapshot, RuntimeContextSnapshot, {
    ...rest,
    id: createStableId('runtime-context-snapshot'),
    conversation: targetConversation,
    ...(sourceRuntimeContexts?.length ? { sourceRuntimeContexts } : {})
  });
  const targetLink = world.spawn();
  world.add(targetLink, ConversationRuntimeContextSnapshotLink, {
    id: `conversation-runtime-context:${targetConversationId}`,
    conversation: targetConversation,
    snapshot: targetSnapshot,
    role: sourceLink.role,
    createdAt: now,
    updatedAt: now
  });
}

function cloneCheckpointHistory(
  world: World,
  sourceConversation: Entity,
  targetConversation: Entity,
  sourceMessages: readonly Entity[],
  messageMap: ReadonlyMap<Entity, Entity>,
  toolCallMap: ToolCallCloneMap,
  now: number
): void {
  const sourceMessageById = new Map<string, Entity>();
  for (const sourceMessage of sourceMessages) {
    const data = world.get(sourceMessage, Message);
    if (data) sourceMessageById.set(data.id, sourceMessage);
  }
  const sourceToolCallById = new Map<string, Entity>();
  for (const sourceToolCall of toolCallMap.keys()) {
    const data = world.get(sourceToolCall, ToolCall);
    if (data) sourceToolCallById.set(data.id, sourceToolCall);
  }

  const eligibleAnchors: Array<{ entity: Entity; targetFloor: Entity }> = [];
  const sourceCheckpoints = new Set<Entity>();
  for (const entity of world.query(CheckpointTimelineAnchor)) {
    const anchor = world.get(entity, CheckpointTimelineAnchor);
    if (!anchor || anchor.conversation !== sourceConversation) continue;
    const sourceFloor = anchor.floorMessage !== undefined && messageMap.has(anchor.floorMessage)
      ? anchor.floorMessage
      : sourceMessageById.get(anchor.floorMessageId);
    const targetFloor = sourceFloor !== undefined ? messageMap.get(sourceFloor) : undefined;
    if (targetFloor === undefined) continue;
    eligibleAnchors.push({ entity, targetFloor });
    sourceCheckpoints.add(anchor.checkpoint);
  }
  for (const entity of world.query(Checkpoint)) {
    const checkpoint = world.get(entity, Checkpoint);
    if (checkpoint?.conversation === sourceConversation
      && checkpoint.status !== 'pending'
      && checkpoint.trigger === 'conversation_initial') {
      sourceCheckpoints.add(entity);
    }
  }

  const checkpointMap = new Map<Entity, Entity>();
  const orderedCheckpoints = [...sourceCheckpoints].sort((left, right) => {
    const leftData = world.get(left, Checkpoint);
    const rightData = world.get(right, Checkpoint);
    return (leftData?.createdAt ?? 0) - (rightData?.createdAt ?? 0) || left - right;
  });
  for (const sourceCheckpoint of orderedCheckpoints) {
    const source = world.get(sourceCheckpoint, Checkpoint);
    if (!source || source.status === 'pending') continue;
    const target = world.spawn();
    const cloned = clonePlainData(source);
    const { id: _id, conversation: _conversation, ...rest } = cloned;
    world.add(target, Checkpoint, {
      ...rest,
      id: createStableId('checkpoint'),
      conversation: targetConversation
    });
    checkpointMap.set(sourceCheckpoint, target);
  }

  cloneCheckpointRepositoryHistory(world, sourceConversation, targetConversation, checkpointMap, now);

  for (const eligible of eligibleAnchors) {
    const source = world.get(eligible.entity, CheckpointTimelineAnchor);
    const targetCheckpoint = source ? checkpointMap.get(source.checkpoint) : undefined;
    const targetFloor = eligible.targetFloor;
    const targetFloorId = world.get(targetFloor, Message)?.id;
    const targetCheckpointId = targetCheckpoint !== undefined ? world.get(targetCheckpoint, Checkpoint)?.id : undefined;
    if (!source || targetCheckpoint === undefined || !targetFloorId || !targetCheckpointId) continue;

    const sourceToolCall = source.sourceToolCall !== undefined && toolCallMap.has(source.sourceToolCall)
      ? source.sourceToolCall
      : source.sourceToolCallId
        ? sourceToolCallById.get(source.sourceToolCallId)
        : undefined;
    const targetToolCall = sourceToolCall !== undefined ? toolCallMap.get(sourceToolCall) : undefined;
    const targetAnchor = world.spawn();
    const cloned = clonePlainData(source);
    const {
      id: _id,
      conversation: _conversation,
      checkpoint: _checkpoint,
      floorMessage: _floorMessage,
      floorMessageId: _floorMessageId,
      sourceRun: _sourceRun,
      sourceRunId: _sourceRunId,
      sourceToolCall: _sourceToolCall,
      sourceToolCallId: _sourceToolCallId,
      ...rest
    } = cloned;
    world.add(targetAnchor, CheckpointTimelineAnchor, {
      ...rest,
      id: `checkpoint-timeline-anchor:${targetCheckpointId}`,
      conversation: targetConversation,
      checkpoint: targetCheckpoint,
      floorMessage: targetFloor,
      floorMessageId: targetFloorId,
      ...(targetToolCall ? { sourceToolCall: targetToolCall.entity, sourceToolCallId: targetToolCall.id } : {})
    });
  }
}

function cloneCheckpointRepositoryHistory(
  world: World,
  sourceConversation: Entity,
  targetConversation: Entity,
  checkpointMap: ReadonlyMap<Entity, Entity>,
  now: number
): void {
  const clonedPairs = new Set<string>();
  for (const sourceCheckpoint of checkpointMap.keys()) {
    const checkpoint = world.get(sourceCheckpoint, Checkpoint);
    if (!checkpoint || !world.has(checkpoint.shadowRepository, ShadowRepository)) continue;
    const pairKey = `${checkpoint.projectContext}:${checkpoint.shadowRepository}`;
    if (clonedPairs.has(pairKey)) continue;
    clonedPairs.add(pairKey);
    const sourceLink = world.query(ConversationCheckpointRepositoryLink)
      .map((entity) => world.get(entity, ConversationCheckpointRepositoryLink))
      .find((link) => !!link
        && link.conversation === sourceConversation
        && link.projectContext === checkpoint.projectContext
        && link.shadowRepository === checkpoint.shadowRepository);
    const targetLink = world.spawn();
    world.add(targetLink, ConversationCheckpointRepositoryLink, {
      id: createStableId('ccrl'),
      conversation: targetConversation,
      projectContext: checkpoint.projectContext,
      shadowRepository: checkpoint.shadowRepository,
      projectUri: sourceLink?.projectUri ?? checkpoint.projectUri,
      projectDisplayPath: sourceLink?.projectDisplayPath ?? checkpoint.projectDisplayPath,
      role: 'history',
      createdAt: now,
      updatedAt: now
    });
  }
}

function currentRevisionForMessage(world: World, message: Entity): Entity | undefined {
  return world.query(MessageCurrentRevisionLink)
    .map((entity) => ({ entity, link: world.get(entity, MessageCurrentRevisionLink) }))
    .filter((item) => item.link?.message === message)
    .sort((left, right) => right.entity - left.entity)[0]?.link?.revision;
}

function findConversation(world: World, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}

function messagesThroughFloor(world: World, messages: readonly Entity[], visibleMessageIndex: number): Entity[] {
  let endExclusive = visibleMessageIndex + 1;
  while (endExclusive < messages.length) {
    const message = world.get(messages[endExclusive]!, Message);
    if (!message?.content.parts.some(isFunctionResponsePart)) break;
    endExclusive += 1;
  }
  return messages.slice(0, endExclusive);
}

function messagesForConversation(world: World, conversation: Entity): Entity[] {
  return world.query(Message, PartOf)
    .filter((entity) => world.get(entity, PartOf)?.parent === conversation)
    .sort((left, right) => {
      const leftMessage = world.get(left, Message)!;
      const rightMessage = world.get(right, Message)!;
      return leftMessage.seq - rightMessage.seq || leftMessage.createdAt - rightMessage.createdAt || leftMessage.id.localeCompare(rightMessage.id);
    });
}

function clonePlainData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clonePlainData(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = clonePlainData(child);
  }
  return result as T;
}
