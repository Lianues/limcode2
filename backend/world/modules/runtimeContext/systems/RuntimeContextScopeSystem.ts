import { defineSystem, type ComponentType, type Entity, type WorldReader } from '../../../../ecs/types';
import { createMessageId } from '../../../../../shared/protocol';
import type { ConfigScopeKind } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Mode } from '../../mode/components';
import { DEFAULT_RUNTIME_CONTEXT_TEMPLATE } from '../placeholders';
import { RuntimeContext, RuntimeContextScopeLink } from '../components';
import { defaultRuntimeContextName, runtimeContextIdForScope, runtimeContextScopeLinkId } from '../bundles';
import { latestRuntimeContextScopeLink, runtimeContextScopeLinkEntities } from '../queries';
import { RuntimeContextEventType } from '../events';

export const RuntimeContextScopeSystem = defineSystem({
  name: 'RuntimeContextScopeSystem',
  shouldRun(ctx) {
    return readEvents(ctx, RuntimeContextEventType.ScopeSet).length > 0
      || readEvents(ctx, RuntimeContextEventType.ScopeClear).length > 0
      || !hasGlobalRuntimeContext(ctx.world);
  },
  access: {
    reads: { components: [Agent, Conversation, Mode, AgentRun, RuntimeContext, RuntimeContextScopeLink] },
    writes: { components: [RuntimeContext, RuntimeContextScopeLink], mutationMode: 'update' },
    events: { read: [RuntimeContextEventType.ScopeSet, RuntimeContextEventType.ScopeClear] }
  },
  run(ctx) {
    const { world, cmd } = ctx;

    if (!hasGlobalRuntimeContext(world)) {
      const now = Date.now();
      const context = cmd.spawn();
      cmd.add(context, RuntimeContext, { id: runtimeContextIdForScope('global'), name: '全局运行时上下文', template: DEFAULT_RUNTIME_CONTEXT_TEMPLATE });
      const link = cmd.spawn();
      cmd.add(link, RuntimeContextScopeLink, { id: runtimeContextScopeLinkId('global'), scopeKind: 'global', runtimeContext: context, role: 'active', createdAt: now, updatedAt: now });
    }

    for (const payload of readEvents(ctx, RuntimeContextEventType.ScopeSet)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      const template = payload.template.trim();
      if (!template) continue;
      const now = Date.now();
      const existing = latestRuntimeContextScopeLink(world, payload.scopeKind, scope.scopeId);
      const runtimeContext = existing ? existing.link.runtimeContext : cmd.spawn();
      const runtimeContextId = existing
        ? world.get(existing.link.runtimeContext, RuntimeContext)?.id ?? runtimeContextIdForScope(payload.scopeKind, scope.scopeId)
        : runtimeContextIdForScope(payload.scopeKind, scope.scopeId);
      cmd.add(runtimeContext, RuntimeContext, { id: runtimeContextId, name: payload.name?.trim() || defaultRuntimeContextName(payload.scopeKind), template });
      if (existing) {
        cmd.add(existing.entity, RuntimeContextScopeLink, { ...existing.link, runtimeContext, ...(payload.order !== undefined ? { order: payload.order } : {}), updatedAt: now });
      } else {
        const link = cmd.spawn();
        cmd.add(link, RuntimeContextScopeLink, { id: runtimeContextScopeLinkId(payload.scopeKind, scope.scopeId), scopeKind: payload.scopeKind, ...(scope.scopeId ? { scopeId: scope.scopeId } : {}), runtimeContext, ...scope.data, role: 'active', ...(payload.order !== undefined ? { order: payload.order } : {}), createdAt: now, updatedAt: now });
      }
    }

    for (const payload of readEvents(ctx, RuntimeContextEventType.ScopeClear)) {
      if (payload.scopeKind === 'global') continue;
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      for (const entity of runtimeContextScopeLinkEntities(world, payload.scopeKind, scope.scopeId)) cmd.despawn(entity);
    }
  }
});

type ScopeData = Partial<{ agent: Entity; conversation: Entity; mode: Entity; run: Entity }>;
type ScopeResult = { ok: true; scopeId?: string; data: ScopeData } | { ok: false };

function resolveScope(world: WorldReader, scopeKind: ConfigScopeKind, rawScopeId: string | undefined): ScopeResult {
  const scopeId = rawScopeId?.trim();
  switch (scopeKind) {
    case 'global': return { ok: true, data: {} };
    case 'agent': {
      const agent = scopeId ? findByRecordId(world, Agent, scopeId) : undefined;
      return agent === undefined ? { ok: false } : { ok: true, scopeId, data: { agent } };
    }
    case 'conversation': {
      const conversation = scopeId ? findByRecordId(world, Conversation, scopeId) : undefined;
      return conversation === undefined ? { ok: false } : { ok: true, scopeId, data: { conversation } };
    }
    case 'mode': {
      const mode = scopeId ? findByRecordId(world, Mode, scopeId) : undefined;
      return mode === undefined ? { ok: false } : { ok: true, scopeId, data: { mode } };
    }
    case 'run': {
      const run = scopeId ? findByRecordId(world, AgentRun, scopeId) : undefined;
      return run === undefined ? { ok: false } : { ok: true, scopeId, data: { run } };
    }
  }
}

function hasGlobalRuntimeContext(world: WorldReader): boolean {
  return world.query(RuntimeContextScopeLink).some((entity) => {
    const link = world.get(entity, RuntimeContextScopeLink);
    return link?.scopeKind === 'global' && link.role === 'active' && world.get(link.runtimeContext, RuntimeContext)?.template.trim();
  });
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: ComponentType<T>, id: string): Entity | undefined {
  return world.query(component).find((entity) => world.get(entity, component)?.id === id);
}
