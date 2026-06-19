import type {
  CheckpointPolicyRecord,
  CheckpointPolicyScopeLinkRecord,
  CheckpointRecord,
  ClientState,
  ConversationCheckpointRepositoryLinkRecord,
  ShadowRepositoryRecord
} from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { AgentRun } from '../agentRun/components';
import { Conversation } from '../chat/components';
import { Mode } from '../mode/components';
import { ProjectContext } from '../project/components';
import {
  Checkpoint,
  CheckpointPolicy,
  CheckpointPolicyScopeLink,
  ConversationCheckpointRepositoryLink,
  ShadowRepository,
  type CheckpointPolicyScopeLinkData
} from './components';

export const checkpointStateProjectionReads: AccessDeclaration = {
  components: [
    Agent,
    AgentRun,
    Conversation,
    Mode,
    ProjectContext,
    CheckpointPolicy,
    CheckpointPolicyScopeLink,
    ShadowRepository,
    ConversationCheckpointRepositoryLink,
    Checkpoint
  ]
};

export function checkpointStateProjection(world: WorldReader): Partial<ClientState> {
  const checkpointPolicies: CheckpointPolicyRecord[] = world.query(CheckpointPolicy).map((entity) => ({ ...world.get(entity, CheckpointPolicy)! }));
  const checkpointPolicyScopeLinks: CheckpointPolicyScopeLinkRecord[] = world
    .query(CheckpointPolicyScopeLink)
    .map((entity) => buildCheckpointPolicyScopeLinkRecord(world, entity))
    .filter((item): item is CheckpointPolicyScopeLinkRecord => item !== undefined);
  const shadowRepositories: ShadowRepositoryRecord[] = world.query(ShadowRepository).map((entity) => ({ ...world.get(entity, ShadowRepository)! }));
  const conversationCheckpointRepositoryLinks: ConversationCheckpointRepositoryLinkRecord[] = world
    .query(ConversationCheckpointRepositoryLink)
    .map((entity) => buildConversationCheckpointRepositoryLinkRecord(world, entity))
    .filter((item): item is ConversationCheckpointRepositoryLinkRecord => item !== undefined);
  const checkpoints: CheckpointRecord[] = world
    .query(Checkpoint)
    .map((entity) => buildCheckpointRecord(world, entity))
    .filter((item): item is CheckpointRecord => item !== undefined);

  return { checkpointPolicies, checkpointPolicyScopeLinks, shadowRepositories, conversationCheckpointRepositoryLinks, checkpoints };
}

function buildCheckpointPolicyScopeLinkRecord(world: WorldReader, entity: number): CheckpointPolicyScopeLinkRecord | undefined {
  const link = world.get(entity, CheckpointPolicyScopeLink);
  if (!link) return undefined;
  const policy = world.get(link.checkpointPolicy, CheckpointPolicy);
  if (!policy) return undefined;
  const scopeId = scopeIdForLink(world, link);
  if (link.scopeKind !== 'global' && !scopeId) return undefined;
  return {
    id: link.id,
    scopeKind: link.scopeKind,
    ...(scopeId ? { scopeId } : {}),
    checkpointPolicyId: policy.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function buildConversationCheckpointRepositoryLinkRecord(world: WorldReader, entity: number): ConversationCheckpointRepositoryLinkRecord | undefined {
  const link = world.get(entity, ConversationCheckpointRepositoryLink);
  if (!link) return undefined;
  const conversation = world.get(link.conversation, Conversation);
  const projectContext = world.get(link.projectContext, ProjectContext);
  const shadowRepository = world.get(link.shadowRepository, ShadowRepository);
  if (!conversation || !projectContext || !shadowRepository) return undefined;
  return {
    id: link.id,
    conversationId: conversation.id,
    projectContextId: projectContext.id,
    shadowRepositoryId: shadowRepository.id,
    projectUri: link.projectUri,
    projectDisplayPath: link.projectDisplayPath,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function buildCheckpointRecord(world: WorldReader, entity: number): CheckpointRecord | undefined {
  const checkpoint = world.get(entity, Checkpoint);
  if (!checkpoint) return undefined;
  const conversation = world.get(checkpoint.conversation, Conversation);
  const projectContext = world.get(checkpoint.projectContext, ProjectContext);
  const shadowRepository = world.get(checkpoint.shadowRepository, ShadowRepository);
  if (!conversation || !projectContext || !shadowRepository) return undefined;
  return {
    id: checkpoint.id,
    conversationId: conversation.id,
    projectContextId: projectContext.id,
    shadowRepositoryId: shadowRepository.id,
    trigger: checkpoint.trigger,
    status: checkpoint.status,
    projectUri: checkpoint.projectUri,
    projectDisplayPath: checkpoint.projectDisplayPath,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
    ...(checkpoint.commitSha ? { commitSha: checkpoint.commitSha } : {}),
    ...(checkpoint.skipReason ? { skipReason: checkpoint.skipReason } : {}),
    ...(checkpoint.message ? { message: checkpoint.message } : {}),
    ...(checkpoint.fileCount !== undefined ? { fileCount: checkpoint.fileCount } : {}),
    ...(checkpoint.byteCount !== undefined ? { byteCount: checkpoint.byteCount } : {}),
    ...(checkpoint.emptyDirectoryCount !== undefined ? { emptyDirectoryCount: checkpoint.emptyDirectoryCount } : {})
  };
}

function scopeIdForLink(world: WorldReader, link: CheckpointPolicyScopeLinkData): string | undefined {
  if (link.scopeKind === 'global') return undefined;
  if (link.scopeId) return link.scopeId;
  switch (link.scopeKind) {
    case 'conversation': return link.conversation !== undefined ? world.get(link.conversation, Conversation)?.id : undefined;
    case 'agent': return link.agent !== undefined ? world.get(link.agent, Agent)?.id : undefined;
    case 'mode': return link.mode !== undefined ? world.get(link.mode, Mode)?.id : undefined;
    case 'run': return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
  }
}
