import type { Entity, World } from '../ecs/types';
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
  ConversationWorkflowSelection,
  Workflow,
  type ConversationWorkflowSelectionData
} from '../world/modules/workflow/components';
import { ConversationProjectLink } from '../world/modules/project/components';
import { ToolCall, ToolCallEvent, ToolState } from '../world/modules/tools/components';
import { ConversationWorkEnvironmentLink } from '../world/modules/workEnvironment/components';
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
  cloneMessageRevisions(world, messagesToCopy, messageMap);
  cloneToolSnapshots(world, messageMap, now);
  cloneAgentRelations(world, conversation, targetConversationId, agentContext, now);
  cloneWorkflowSelection(world, sourceConversation, conversation, targetConversationId, now);
  cloneProjectLinks(world, sourceConversation, conversation, now);
  cloneWorkEnvironmentLinks(world, sourceConversation, conversation, now);

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

function cloneMessageRevisions(world: World, sourceMessages: readonly Entity[], messageMap: ReadonlyMap<Entity, Entity>): void {
  const sourceMessageSet = new Set(sourceMessages);
  const revisionMap = new Map<Entity, Entity>();
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
    world.add(targetRevision, MessageRevision, {
      ...clonePlainData(sourceRevision.data),
      id: createStableId('rev'),
      content: clonePlainData(sourceRevision.data.content)
    });
    world.add(targetRevision, PartOf, { parent: targetMessage });
    revisionMap.set(sourceRevision.entity, targetRevision);
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
}

function cloneToolSnapshots(world: World, messageMap: ReadonlyMap<Entity, Entity>, now: number): void {
  const toolCallMap = new Map<Entity, { entity: Entity; id: string }>();
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
