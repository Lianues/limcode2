import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { createMessageId } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun, AgentRunTargetLink } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Mode, ConversationModeSelection } from '../../mode/components';
import { ConversationProjectLink, ProjectContext, type ProjectContextData } from '../../project/components';
import { CheckpointPolicy, CheckpointPolicyScopeLink, ConversationCheckpointRepositoryLink, ShadowRepository } from '../components';
import { CheckpointEventType } from '../events';
import {
  CheckpointBundle,
  ensureConversationCheckpointRepositoryLink,
  ensureShadowRepository,
  shadowRepositoryIdFor,
  shadowRepositoryStorageKeyFor
} from '../bundles';
import { effectiveCheckpointPolicyForRequest, findRunById } from '../queries';
import { triggerConfigKey } from '../policy';

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
        policy: resolution.policy
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
