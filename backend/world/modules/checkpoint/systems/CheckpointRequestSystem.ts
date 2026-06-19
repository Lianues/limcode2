import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { createMessageId } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun, AgentRunTargetLink } from '../../agentRun/components';
import { Conversation, Message, PartOf } from '../../chat/components';
import { Mode, ConversationModeSelection } from '../../mode/components';
import { ConversationProjectLink, ProjectContext, type ProjectContextData } from '../../project/components';
import { ToolCall } from '../../tools/components';
import { CheckpointPolicy, CheckpointPolicyScopeLink, ConversationCheckpointRepositoryLink, ShadowRepository } from '../components';
import { CheckpointEventType, type CheckpointRequestedPayload } from '../events';
import {
  CheckpointBundle,
  ensureConversationCheckpointRepositoryLink,
  ensureShadowRepository,
  shadowRepositoryIdFor,
  shadowRepositoryStorageKeyFor
} from '../bundles';
import { effectiveCheckpointPolicyForRequest, findRunById } from '../queries';
import { triggerConfigKey } from '../policy';
import type { CheckpointFloorAnchorPosition } from '../../../../../shared/protocol';

const CheckpointRequestQuery = defineQuery({
  name: 'CheckpointRequest',
  all: [Conversation],
  read: [
    Conversation,
    Agent,
    AgentRun,
    AgentRunTargetLink,
    Mode,
    ConversationModeSelection,
    ProjectContext,
    ConversationProjectLink,
    Message,
    PartOf,
    ToolCall,
    CheckpointPolicy,
    CheckpointPolicyScopeLink,
    ShadowRepository,
    ConversationCheckpointRepositoryLink
  ],
  role: 'work'
});

export const CheckpointRequestSystem = defineSystem({
  name: 'CheckpointRequestSystem',
  access: {
    queries: [CheckpointRequestQuery],
    bundles: [CheckpointBundle],
    events: { read: [CheckpointEventType.Requested] },
    effects: { emit: ['checkpoint.create'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, CheckpointEventType.Requested)) {
      const conversation = findConversationById(world, payload.conversationId);
      if (conversation === undefined) continue;
      const project = primaryProjectForConversation(world, conversation);
      if (!project) continue;
      const run = findRunById(world, payload.runId);
      const resolution = effectiveCheckpointPolicyForRequest(world, { conversation, ...(run !== undefined ? { run } : {}) });
      if (!resolution.policy.enabled) continue;
      const triggerKey = triggerConfigKey(payload.trigger);
      if (!triggerKey || resolution.policy.triggers[triggerKey] !== true) continue;

      const repository = ensureShadowRepository(world, cmd, { conversationId: payload.conversationId, projectUri: project.data.uri });
      const repositoryId = shadowRepositoryIdFor(payload.conversationId, project.data.uri);
      const repositoryStorageKey = shadowRepositoryStorageKeyFor(payload.conversationId, project.data.uri);
      ensureConversationCheckpointRepositoryLink(world, cmd, {
        conversation,
        conversationId: payload.conversationId,
        projectContext: project.entity,
        projectContextId: project.data.id,
        projectUri: project.data.uri,
        projectDisplayPath: project.data.name || project.data.uri,
        shadowRepository: repository,
        shadowRepositoryId: repositoryId
      });

      const anchor = resolveCheckpointAnchor(world, payload, conversation);
      cmd.effect({
        kind: 'checkpoint.create',
        checkpointId: createMessageId(),
        conversationId: payload.conversationId,
        projectContextId: project.data.id,
        projectUri: project.data.uri,
        projectDisplayPath: project.data.name || project.data.uri,
        shadowRepositoryId: repositoryId,
        shadowRepositoryStorageKey: repositoryStorageKey,
        trigger: payload.trigger,
        policy: resolution.policy,
        ...anchor
      });
    }
  }
});

function findConversationById(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}

function primaryProjectForConversation(world: WorldReader, conversation: Entity): { entity: Entity; data: ProjectContextData } | undefined {
  for (const entity of world.query(ConversationProjectLink)) {
    const link = world.get(entity, ConversationProjectLink);
    if (!link || link.conversation !== conversation || link.role !== 'primary') continue;
    const data = world.get(link.projectContext, ProjectContext);
    if (data) return { entity: link.projectContext, data };
  }
  return undefined;
}

interface CheckpointAnchorResolution {
  floorMessageId?: string;
  anchorPosition?: CheckpointFloorAnchorPosition;
  sourceRunId?: string;
  sourceToolCallId?: string;
}

function resolveCheckpointAnchor(world: WorldReader, payload: CheckpointRequestedPayload, conversation: Entity): CheckpointAnchorResolution {
  const base = {
    ...(payload.runId ? { sourceRunId: payload.runId } : {}),
    ...(payload.toolCallId ? { sourceToolCallId: payload.toolCallId } : {})
  };
  const explicitMessage = payload.floorMessageId ? findConversationMessageById(world, conversation, payload.floorMessageId) : undefined;
  if (explicitMessage !== undefined) {
    return { ...base, floorMessageId: payload.floorMessageId, anchorPosition: payload.anchorPosition ?? 'after' };
  }

  const toolMessage = payload.toolCallId ? messageForToolCall(world, conversation, payload.toolCallId) : undefined;
  if (toolMessage) {
    return { ...base, floorMessageId: toolMessage.id, anchorPosition: payload.anchorPosition ?? 'after' };
  }

  return base;
}

function findConversationMessageById(world: WorldReader, conversation: Entity, messageId: string): Entity | undefined {
  return world.query(Message, PartOf).find((entity) => {
    const message = world.get(entity, Message);
    const parent = world.get(entity, PartOf)?.parent;
    return message?.id === messageId && parent === conversation;
  });
}

function messageForToolCall(world: WorldReader, conversation: Entity, toolCallId: string): { id: string } | undefined {
  const toolCall = world.query(ToolCall, PartOf).find((entity) => world.get(entity, ToolCall)?.id === toolCallId);
  const messageEntity = toolCall !== undefined ? world.get(toolCall, PartOf)?.parent : undefined;
  if (messageEntity === undefined || world.get(messageEntity, PartOf)?.parent !== conversation) return undefined;
  return world.get(messageEntity, Message);
}
