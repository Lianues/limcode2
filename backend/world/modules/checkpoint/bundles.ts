import { defineBundle, type CommandSink, type Entity, type WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { AgentRun } from '../agentRun/components';
import { Conversation } from '../chat/components';
import { Mode } from '../mode/components';
import { ProjectContext } from '../project/components';
import {
  Checkpoint,
  CheckpointPolicy,
  CheckpointPolicyScopeLink,
  CheckpointTimelineAnchor,
  ConversationCheckpointRepositoryLink,
  ShadowRepository,
  type CheckpointPolicyData,
  type CheckpointPolicyScopeLinkData
} from './components';
import { normalizeCheckpointPolicy, safeStorageKey } from './policy';
import type { CheckpointPolicyScopeKind } from '../../../../shared/protocol';

export const CheckpointBundle = defineBundle({
  name: 'CheckpointBundle',
  writes: [CheckpointPolicy, CheckpointPolicyScopeLink, ShadowRepository, ConversationCheckpointRepositoryLink, Checkpoint, CheckpointTimelineAnchor],
  mutationMode: 'update',
  spawns: true,
  despawns: true
});

export function upsertCheckpointPolicy(
  world: WorldReader,
  cmd: CommandSink,
  input: Partial<CheckpointPolicyData> & { id: string; name: string }
): Entity {
  const existing = findCheckpointPolicyById(world, input.id);
  const previous = existing !== undefined ? world.get(existing, CheckpointPolicy) : undefined;
  const next = normalizeCheckpointPolicy({ ...(previous ?? {}), ...input, updatedAt: Date.now() });
  if (existing !== undefined) {
    cmd.add(existing, CheckpointPolicy, next);
    return existing;
  }
  const entity = cmd.spawn();
  cmd.add(entity, CheckpointPolicy, next);
  return entity;
}

export function upsertCheckpointPolicyScopeLink(
  world: WorldReader,
  cmd: CommandSink,
  input: {
    scopeKind: CheckpointPolicyScopeKind;
    scopeId?: string;
    policy: Entity;
    data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity }>;
  }
): Entity {
  const now = Date.now();
  const existing = findActiveCheckpointPolicyScopeLink(world, input.scopeKind, input.scopeId);
  if (existing) {
    cmd.add(existing.entity, CheckpointPolicyScopeLink, {
      ...existing.link,
      checkpointPolicy: input.policy,
      ...input.data,
      updatedAt: now
    });
    return existing.entity;
  }

  const entity = cmd.spawn();
  cmd.add(entity, CheckpointPolicyScopeLink, {
    id: checkpointPolicyScopeLinkId(input.scopeKind, input.scopeId),
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    checkpointPolicy: input.policy,
    ...input.data,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function ensureShadowRepository(
  world: WorldReader,
  cmd: CommandSink,
  input: { conversationId: string; projectUri: string }
): Entity {
  const id = shadowRepositoryIdFor(input.conversationId, input.projectUri);
  const existing = findShadowRepositoryById(world, id);
  const now = Date.now();
  if (existing !== undefined) {
    const current = world.get(existing, ShadowRepository);
    if (current) cmd.add(existing, ShadowRepository, { ...current, updatedAt: now });
    return existing;
  }
  const entity = cmd.spawn();
  cmd.add(entity, ShadowRepository, {
    id,
    storageKey: shadowRepositoryStorageKeyFor(input.conversationId, input.projectUri),
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function ensureConversationCheckpointRepositoryLink(
  world: WorldReader,
  cmd: CommandSink,
  input: {
    conversation: Entity;
    conversationId: string;
    projectContext: Entity;
    projectContextId: string;
    projectUri: string;
    projectDisplayPath: string;
    shadowRepository: Entity;
    shadowRepositoryId: string;
  }
): Entity {
  const now = Date.now();
  let active: Entity | undefined;
  for (const entity of world.query(ConversationCheckpointRepositoryLink)) {
    const link = world.get(entity, ConversationCheckpointRepositoryLink);
    if (!link || link.conversation !== input.conversation || link.role !== 'active') continue;
    if (link.projectContext === input.projectContext && link.shadowRepository === input.shadowRepository) {
      active = entity;
      continue;
    }
    cmd.add(entity, ConversationCheckpointRepositoryLink, { ...link, role: 'history', updatedAt: now });
  }
  if (active !== undefined) {
    const current = world.get(active, ConversationCheckpointRepositoryLink)!;
    cmd.add(active, ConversationCheckpointRepositoryLink, { ...current, projectDisplayPath: input.projectDisplayPath, updatedAt: now });
    return active;
  }

  const entity = cmd.spawn();
  cmd.add(entity, ConversationCheckpointRepositoryLink, {
    id: conversationCheckpointRepositoryLinkId(input.conversationId, input.projectContextId),
    conversation: input.conversation,
    projectContext: input.projectContext,
    shadowRepository: input.shadowRepository,
    projectUri: input.projectUri,
    projectDisplayPath: input.projectDisplayPath,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function findActiveCheckpointPolicyScopeLink(
  world: WorldReader,
  scopeKind: CheckpointPolicyScopeKind,
  scopeId: string | undefined
): { entity: Entity; link: CheckpointPolicyScopeLinkData } | undefined {
  const normalized = scopeKind === 'global' ? undefined : scopeId;
  const matches = world
    .query(CheckpointPolicyScopeLink)
    .filter((entity) => {
      const link = world.get(entity, CheckpointPolicyScopeLink);
      return !!link && link.role === 'active' && link.scopeKind === scopeKind && scopeIdForLink(world, link) === normalized;
    })
    .sort((left, right) => {
      const leftLink = world.get(left, CheckpointPolicyScopeLink)!;
      const rightLink = world.get(right, CheckpointPolicyScopeLink)!;
      return (leftLink.updatedAt || leftLink.createdAt) - (rightLink.updatedAt || rightLink.createdAt) || left - right;
    });
  const entity = matches[matches.length - 1];
  const link = entity === undefined ? undefined : world.get(entity, CheckpointPolicyScopeLink);
  return entity === undefined || !link ? undefined : { entity, link };
}

export function checkpointPolicyIdForScope(scopeKind: CheckpointPolicyScopeKind, scopeId: string | undefined): string {
  return `checkpoint-policy:${scopeKind}:${scopeId ?? 'global'}`;
}

function checkpointPolicyScopeLinkId(scopeKind: CheckpointPolicyScopeKind, scopeId: string | undefined): string {
  return `checkpoint-policy-scope:${scopeKind}:${scopeId ?? 'global'}`;
}

export function shadowRepositoryIdFor(conversationId: string, projectUri: string): string {
  return `shadow-repository:${conversationId}:${hashText(projectUri)}`;
}

export function shadowRepositoryStorageKeyFor(conversationId: string, projectUri: string): string {
  return safeStorageKey(shadowRepositoryIdFor(conversationId, projectUri));
}

function conversationCheckpointRepositoryLinkId(conversationId: string, projectContextId: string): string {
  return `conversation-checkpoint-repository:${conversationId}:${projectContextId}`;
}

function hashText(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function findCheckpointPolicyById(world: WorldReader, id: string): Entity | undefined {
  return findByRecordId(world, CheckpointPolicy, id);
}

function findShadowRepositoryById(world: WorldReader, id: string): Entity | undefined {
  return findByRecordId(world, ShadowRepository, id);
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

function findByRecordId<T extends { id: string }>(world: WorldReader, component: { id: symbol }, id: string): Entity | undefined {
  return world.query(component as never).find((entity) => (world.get(entity, component as never) as T | undefined)?.id === id);
}
