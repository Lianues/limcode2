import type { Entity, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { agentTypeEntityForRuntimeAgent } from '../agent/identity';
import { AgentRun } from '../agentRun/components';
import { activeAgentForConversation, activeModeForRun, activeModeSelectionForConversation, runTarget } from '../agentRun/queries';
import { Conversation } from '../chat/components';
import { Mode } from '../mode/components';
import {
  ConversationRuntimeContextSnapshotLink,
  RuntimeContext,
  RuntimeContextScopeLink,
  RuntimeContextSnapshot,
  RunRuntimeContextSnapshotLink,
  type RuntimeContextData,
  type RuntimeContextScopeLinkData,
  type RuntimeContextSnapshotData
} from './components';

interface ScopeEntity { kind: 'global' | 'agent' | 'mode' | 'conversation' | 'run'; entity?: Entity }

export interface ResolvedRuntimeContextSnapshot {
  entity: Entity;
  data: RuntimeContextSnapshotData;
}

export function runtimeContextsForRun(world: WorldReader, run: Entity, conversation?: Entity): RuntimeContextData[] {
  const target = runTarget(world, run);
  const mode = activeModeForRun(world, run);
  const targetConversation = conversation ?? target?.conversation;
  const scopes: ScopeEntity[] = [
    { kind: 'global' },
    ...(target ? [{ kind: 'agent' as const, entity: agentTypeEntityForRuntimeAgent(world, target.agent) }] : []),
    ...(mode !== undefined ? [{ kind: 'mode' as const, entity: mode }] : []),
    ...(targetConversation !== undefined ? [{ kind: 'conversation' as const, entity: targetConversation }] : []),
    { kind: 'run', entity: run }
  ];

  const contexts: RuntimeContextData[] = [];
  for (const scope of scopes) {
    for (const link of activeRuntimeContextLinksForScope(world, scope)) {
      const context = world.get(link.runtimeContext, RuntimeContext);
      if (context?.template.trim()) contexts.push(context);
    }
  }
  return contexts;
}

export function runtimeContextsForConversation(world: WorldReader, conversation: Entity): RuntimeContextData[] {
  const agent = activeAgentForConversation(world, conversation);
  const modeSelection = activeModeSelectionForConversation(world, conversation);
  const mode = modeSelection?.scopeKind === 'mode' ? modeSelection.mode : undefined;
  const scopes: ScopeEntity[] = [
    { kind: 'global' },
    ...(agent !== undefined ? [{ kind: 'agent' as const, entity: agentTypeEntityForRuntimeAgent(world, agent) }] : []),
    ...(mode !== undefined ? [{ kind: 'mode' as const, entity: mode }] : []),
    { kind: 'conversation', entity: conversation }
  ];

  const contexts: RuntimeContextData[] = [];
  for (const scope of scopes) {
    for (const link of activeRuntimeContextLinksForScope(world, scope)) {
      const context = world.get(link.runtimeContext, RuntimeContext);
      if (context?.template.trim()) contexts.push(context);
    }
  }
  return contexts;
}


export function runRuntimeContextSnapshots(world: WorldReader, run: Entity): ResolvedRuntimeContextSnapshot[] {
  return world
    .query(RunRuntimeContextSnapshotLink)
    .map((entity) => {
      const link = world.get(entity, RunRuntimeContextSnapshotLink);
      if (!link || link.run !== run || link.role !== 'context') return undefined;
      const data = world.get(link.snapshot, RuntimeContextSnapshot);
      return data ? { entity: link.snapshot, data } : undefined;
    })
    .filter((item): item is ResolvedRuntimeContextSnapshot => item !== undefined)
    .sort((left, right) => left.data.createdAt - right.data.createdAt || left.data.id.localeCompare(right.data.id));
}

export function activeRuntimeContextSnapshotForConversation(world: WorldReader, conversation: Entity): ResolvedRuntimeContextSnapshot | undefined {
  return world
    .query(ConversationRuntimeContextSnapshotLink)
    .map((entity) => {
      const link = world.get(entity, ConversationRuntimeContextSnapshotLink);
      if (!link || link.conversation !== conversation || link.role !== 'active') return undefined;
      const data = world.get(link.snapshot, RuntimeContextSnapshot);
      return data ? { entity: link.snapshot, data, updatedAt: link.updatedAt, createdAt: link.createdAt } : undefined;
    })
    .filter((item): item is ResolvedRuntimeContextSnapshot & { updatedAt: number; createdAt: number } => item !== undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.data.id.localeCompare(left.data.id))[0];
}

export function latestRuntimeContextScopeLink(world: WorldReader, scopeKind: RuntimeContextScopeLinkData['scopeKind'], scopeId: string | undefined) {
  const entity = runtimeContextScopeLinkEntities(world, scopeKind, scopeId).at(-1);
  const link = entity === undefined ? undefined : world.get(entity, RuntimeContextScopeLink);
  return entity !== undefined && link ? { entity, link } : undefined;
}

export function runtimeContextScopeLinkEntities(world: WorldReader, scopeKind: RuntimeContextScopeLinkData['scopeKind'], scopeId: string | undefined): Entity[] {
  return world.query(RuntimeContextScopeLink).filter((entity) => {
    const link = world.get(entity, RuntimeContextScopeLink);
    return !!link && link.role === 'active' && link.scopeKind === scopeKind && (scopeKind === 'global' ? link.scopeId === undefined : link.scopeId === scopeId);
  }).sort((left, right) => {
    const a = world.get(left, RuntimeContextScopeLink)!;
    const b = world.get(right, RuntimeContextScopeLink)!;
    return (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt) || left - right;
  });
}

function activeRuntimeContextLinksForScope(world: WorldReader, scope: ScopeEntity): RuntimeContextScopeLinkData[] {
  const links: Array<{ entity: Entity; link: RuntimeContextScopeLinkData }> = [];
  for (const entity of world.query(RuntimeContextScopeLink)) {
    const link = world.get(entity, RuntimeContextScopeLink);
    if (!link || link.role !== 'active' || !matchesRuntimeContextScope(world, link, scope)) continue;
    links.push({ entity, link });
  }
  links.sort((left, right) => (left.link.order ?? 0) - (right.link.order ?? 0) || left.link.createdAt - right.link.createdAt || left.entity - right.entity);
  return links.map((item) => item.link);
}

function matchesRuntimeContextScope(world: WorldReader, link: RuntimeContextScopeLinkData, scope: ScopeEntity): boolean {
  if (link.scopeKind !== scope.kind) return false;
  if (scope.kind === 'global') return true;
  if (scope.entity === undefined) return false;
  switch (scope.kind) {
    case 'agent': return link.agent === scope.entity || (!!link.scopeId && world.get(scope.entity, Agent)?.id === link.scopeId);
    case 'mode': return link.mode === scope.entity || (!!link.scopeId && world.get(scope.entity, Mode)?.id === link.scopeId);
    case 'conversation': return link.conversation === scope.entity || (!!link.scopeId && world.get(scope.entity, Conversation)?.id === link.scopeId);
    case 'run': return link.run === scope.entity || (!!link.scopeId && world.get(scope.entity, AgentRun)?.id === link.scopeId);
  }
}
