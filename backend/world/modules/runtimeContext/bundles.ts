import type { CommandSink, Entity } from '../../../ecs/types';
import type { ConfigScopeKind } from '../../../../shared/protocol';
import {
  ConversationRuntimeContextSnapshotLink,
  RuntimeContext,
  RuntimeContextScopeLink,
  RuntimeContextSnapshot,
  RunRuntimeContextSnapshotLink
} from './components';

export function spawnRuntimeContext(cmd: CommandSink, input: { id: string; name: string; template: string }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, RuntimeContext, { id: input.id, name: input.name, template: input.template });
  return entity;
}

export function linkRuntimeContextToScope(
  cmd: CommandSink,
  input: { scopeKind: ConfigScopeKind; scopeId?: string; runtimeContext: Entity; agent?: Entity; mode?: Entity; conversation?: Entity; run?: Entity; order?: number }
): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, RuntimeContextScopeLink, {
    id: runtimeContextScopeLinkId(input.scopeKind, input.scopeId),
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    runtimeContext: input.runtimeContext,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    ...(input.run !== undefined ? { run: input.run } : {}),
    role: 'active',
    ...(input.order !== undefined ? { order: input.order } : {}),
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function spawnRuntimeContextSnapshot(
  cmd: CommandSink,
  input: { id: string; name: string; text: string; template: string; conversation?: Entity; sourceRuntimeContexts?: Entity[]; sourceHash?: string; now?: number }
): Entity {
  const entity = cmd.spawn();
  const now = input.now ?? Date.now();
  cmd.add(entity, RuntimeContextSnapshot, {
    id: input.id,
    name: input.name,
    text: input.text,
    template: input.template,
    ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    ...(input.sourceRuntimeContexts && input.sourceRuntimeContexts.length > 0 ? { sourceRuntimeContexts: [...input.sourceRuntimeContexts] } : {}),
    ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
    createdAt: now,
    updatedAt: now,
    refreshedAt: now
  });
  return entity;
}

export function linkRuntimeContextSnapshotToConversation(
  cmd: CommandSink,
  input: { conversation: Entity; snapshot: Entity; id: string; previousCreatedAt?: number; now?: number }
): Entity {
  const entity = cmd.spawn();
  const now = input.now ?? Date.now();
  cmd.add(entity, ConversationRuntimeContextSnapshotLink, {
    id: input.id,
    conversation: input.conversation,
    snapshot: input.snapshot,
    role: 'active',
    createdAt: input.previousCreatedAt ?? now,
    updatedAt: now
  });
  return entity;
}

export function linkRuntimeContextSnapshotToRun(
  cmd: CommandSink,
  input: { run: Entity; snapshot: Entity; id: string; now?: number }
): Entity {
  const entity = cmd.spawn();
  const now = input.now ?? Date.now();
  cmd.add(entity, RunRuntimeContextSnapshotLink, {
    id: input.id,
    run: input.run,
    snapshot: input.snapshot,
    role: 'context',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function runtimeContextIdForScope(scopeKind: ConfigScopeKind, scopeId?: string): string { return `runtime-context:${scopeKind}:${scopeId ?? 'global'}`; }
export function runtimeContextScopeLinkId(scopeKind: ConfigScopeKind, scopeId?: string): string { return `runtime-context-scope:${scopeKind}:${scopeId ?? 'global'}`; }
export function defaultRuntimeContextName(scopeKind: ConfigScopeKind): string { return `${scopeKind} Runtime Context`; }
