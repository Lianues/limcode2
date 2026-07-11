import { defineSystem, type ComponentType, type Entity, type WorldReader } from '../../../../ecs/types';
import { createMessageId } from '../../../../../shared/protocol';
import type { ConfigScopeKind } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { Conversation } from '../../chat/components';
import { AgentRun } from '../../agentRun/components';
import { Mode, ModelProfile, ModelProfileScopeLink, SystemPrompt, SystemPromptScopeLink } from '../../mode/components';
import { ToolPolicyScopeLink } from '../../tools/components';
import { WorkEnvironmentPolicyScopeLink } from '../../workEnvironment/components';
import { Agent, AgentConversationLink, AgentKind, AgentStatus, ConversationAgentSelection } from '../components';
import { AgentEventType } from '../events';

export const AgentCrudSystem = defineSystem({
  name: 'AgentCrudSystem',
  shouldRun(ctx) {
    return readEvents(ctx, AgentEventType.Create).length > 0
      || readEvents(ctx, AgentEventType.Update).length > 0
      || readEvents(ctx, AgentEventType.Delete).length > 0
      || readEvents(ctx, AgentEventType.ConversationSelect).length > 0
      || readEvents(ctx, AgentEventType.SystemPromptScopeSet).length > 0
      || readEvents(ctx, AgentEventType.SystemPromptScopeClear).length > 0
      || readEvents(ctx, AgentEventType.ModelProfileScopeSet).length > 0
      || readEvents(ctx, AgentEventType.ModelProfileScopeClear).length > 0;
  },
  access: {
    reads: { components: [Agent, AgentKind, AgentStatus, Conversation, ConversationAgentSelection, AgentConversationLink, Mode, AgentRun, SystemPrompt, SystemPromptScopeLink, ModelProfile, ModelProfileScopeLink, ToolPolicyScopeLink, WorkEnvironmentPolicyScopeLink] },
    writes: { components: [Agent, AgentKind, AgentStatus, ConversationAgentSelection, AgentConversationLink, SystemPrompt, SystemPromptScopeLink, ModelProfile, ModelProfileScopeLink, ToolPolicyScopeLink, WorkEnvironmentPolicyScopeLink], mutationMode: 'update' },
    events: { read: [AgentEventType.Create, AgentEventType.Update, AgentEventType.Delete, AgentEventType.ConversationSelect, AgentEventType.SystemPromptScopeSet, AgentEventType.SystemPromptScopeClear, AgentEventType.ModelProfileScopeSet, AgentEventType.ModelProfileScopeClear] }
  },
  run(ctx) {
    const { world, cmd } = ctx;

    for (const payload of readEvents(ctx, AgentEventType.Create)) {
      const name = normalizeName(payload.name, '新 Agent');
      const id = `agent:${createMessageId()}`;
      const entity = cmd.spawn();
      cmd.add(entity, Agent, { id, name, ...(normalizeText(payload.description) ? { description: normalizeText(payload.description) } : {}), source: 'user' });
      cmd.add(entity, AgentKind, { kind: normalizeKind(payload.kind, 'custom') });
      cmd.add(entity, AgentStatus, { status: 'idle' });
    }

    for (const payload of readEvents(ctx, AgentEventType.Update)) {
      const entity = findByRecordId(world, Agent, payload.agentId);
      if (entity === undefined) continue;
      const current = world.get(entity, Agent);
      if (!current) continue;
      const nextDescription = payload.description === undefined ? current.description : normalizeText(payload.description);
      const next = {
        ...current,
        ...(payload.name !== undefined ? { name: normalizeName(payload.name, current.name) } : {}),
        ...(nextDescription ? { description: nextDescription } : {})
      };
      if (!nextDescription) delete next.description;
      cmd.add(entity, Agent, next);
      if (payload.kind !== undefined) cmd.add(entity, AgentKind, { kind: normalizeKind(payload.kind, world.get(entity, AgentKind)?.kind ?? 'custom') });
    }

    for (const payload of readEvents(ctx, AgentEventType.Delete)) {
      const entity = findByRecordId(world, Agent, payload.agentId);
      if (entity === undefined) continue;
      const current = world.get(entity, Agent);
      if (!current || current.source === 'builtin') continue;
      for (const related of relatedAgentEntities(world, entity, current.id)) cmd.despawn(related);
      cmd.despawn(entity);
    }

    for (const payload of readEvents(ctx, AgentEventType.ConversationSelect)) {
      const conversation = findByRecordId(world, Conversation, payload.conversationId);
      const agent = findByRecordId(world, Agent, payload.agentId);
      if (conversation === undefined || agent === undefined) continue;
      ensureAgentConversationLink(world, cmd, agent, conversation);
      const now = Date.now();
      let selected: Entity | undefined;
      for (const entity of world.query(ConversationAgentSelection)) {
        const current = world.get(entity, ConversationAgentSelection);
        if (!current || current.conversation !== conversation || current.role !== 'active') continue;
        if (selected === undefined) selected = entity;
        else cmd.despawn(entity);
      }
      const entity = selected ?? cmd.spawn();
      const previous = selected !== undefined ? world.get(selected, ConversationAgentSelection) : undefined;
      cmd.add(entity, ConversationAgentSelection, {
        id: `conversation-agent:${payload.conversationId}:${payload.agentId}`,
        conversation,
        agent,
        role: 'active',
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      });
    }

    for (const payload of readEvents(ctx, AgentEventType.SystemPromptScopeSet)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      const text = payload.text.trim();
      if (!text) continue;
      const now = Date.now();
      const existing = latestSystemPromptScopeLink(world, payload.scopeKind, scope.scopeId);
      const prompt = existing ? existing.link.systemPrompt : cmd.spawn();
      const promptId = existing ? world.get(existing.link.systemPrompt, SystemPrompt)?.id ?? systemPromptIdForScope(payload.scopeKind, scope.scopeId) : systemPromptIdForScope(payload.scopeKind, scope.scopeId);
      cmd.add(prompt, SystemPrompt, { id: promptId, name: payload.name?.trim() || defaultSystemPromptName(payload.scopeKind), text });
      if (existing) {
        cmd.add(existing.entity, SystemPromptScopeLink, { ...existing.link, systemPrompt: prompt, ...(payload.order !== undefined ? { order: payload.order } : {}), updatedAt: now });
      } else {
        const link = cmd.spawn();
        cmd.add(link, SystemPromptScopeLink, { id: systemPromptScopeLinkId(payload.scopeKind, scope.scopeId), scopeKind: payload.scopeKind, ...(scope.scopeId ? { scopeId: scope.scopeId } : {}), systemPrompt: prompt, ...scope.data, role: 'active', ...(payload.order !== undefined ? { order: payload.order } : {}), createdAt: now, updatedAt: now });
      }
    }

    for (const payload of readEvents(ctx, AgentEventType.SystemPromptScopeClear)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      for (const entity of scopeLinkEntities(world, SystemPromptScopeLink, payload.scopeKind, scope.scopeId)) cmd.despawn(entity);
    }

    for (const payload of readEvents(ctx, AgentEventType.ModelProfileScopeSet)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      const model = payload.model.trim();
      if (!model) continue;
      const now = Date.now();
      const existing = latestModelProfileScopeLink(world, payload.scopeKind, scope.scopeId);
      const profile = existing ? existing.link.modelProfile : cmd.spawn();
      const profileId = existing ? world.get(existing.link.modelProfile, ModelProfile)?.id ?? modelProfileIdForScope(payload.scopeKind, scope.scopeId) : modelProfileIdForScope(payload.scopeKind, scope.scopeId);
      cmd.add(profile, ModelProfile, { id: profileId, name: payload.name?.trim() || defaultModelProfileName(payload.scopeKind), ...(payload.providerConfigId?.trim() ? { providerConfigId: payload.providerConfigId.trim() } : {}), ...(payload.provider ? { provider: payload.provider } : {}), model });
      if (existing) {
        cmd.add(existing.entity, ModelProfileScopeLink, { ...existing.link, modelProfile: profile, updatedAt: now });
      } else {
        const link = cmd.spawn();
        cmd.add(link, ModelProfileScopeLink, { id: modelProfileScopeLinkId(payload.scopeKind, scope.scopeId), scopeKind: payload.scopeKind, ...(scope.scopeId ? { scopeId: scope.scopeId } : {}), modelProfile: profile, ...scope.data, role: 'active', createdAt: now, updatedAt: now });
      }
    }

    for (const payload of readEvents(ctx, AgentEventType.ModelProfileScopeClear)) {
      if (payload.scopeKind === 'global') continue;
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      for (const entity of scopeLinkEntities(world, ModelProfileScopeLink, payload.scopeKind, scope.scopeId)) cmd.despawn(entity);
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
      if (!scopeId) return { ok: false };
      const agent = findByRecordId(world, Agent, scopeId);
      return { ok: true, scopeId, data: agent !== undefined ? { agent } : {} };
    }
    case 'conversation': {
      if (!scopeId) return { ok: false };
      const conversation = findByRecordId(world, Conversation, scopeId);
      return { ok: true, scopeId, data: conversation !== undefined ? { conversation } : {} };
    }
    case 'mode': {
      if (!scopeId) return { ok: false };
      const mode = findByRecordId(world, Mode, scopeId);
      return { ok: true, scopeId, data: mode !== undefined ? { mode } : {} };
    }
    case 'run': {
      if (!scopeId) return { ok: false };
      const run = findByRecordId(world, AgentRun, scopeId);
      return { ok: true, scopeId, data: run !== undefined ? { run } : {} };
    }
  }
}

function relatedAgentEntities(world: WorldReader, agent: Entity, agentId: string): Entity[] {
  const result: Entity[] = [];
  for (const entity of world.query(AgentConversationLink)) if (world.get(entity, AgentConversationLink)?.agent === agent) result.push(entity);
  for (const entity of world.query(ConversationAgentSelection)) if (world.get(entity, ConversationAgentSelection)?.agent === agent) result.push(entity);
  for (const entity of world.query(SystemPromptScopeLink)) {
    const link = world.get(entity, SystemPromptScopeLink);
    if (link?.scopeKind === 'agent' && (link.agent === agent || link.scopeId === agentId)) result.push(entity);
  }
  for (const entity of world.query(ModelProfileScopeLink)) {
    const link = world.get(entity, ModelProfileScopeLink);
    if (link?.scopeKind === 'agent' && (link.agent === agent || link.scopeId === agentId)) result.push(entity);
  }
  for (const entity of world.query(ToolPolicyScopeLink)) {
    const link = world.get(entity, ToolPolicyScopeLink);
    if (link?.scopeKind === 'agent' && (link.agent === agent || link.scopeId === agentId)) result.push(entity);
  }
  for (const entity of world.query(WorkEnvironmentPolicyScopeLink)) {
    const link = world.get(entity, WorkEnvironmentPolicyScopeLink);
    if (link?.scopeKind === 'agent' && link.scopeId === agentId) result.push(entity);
  }
  return result;
}

function ensureAgentConversationLink(world: WorldReader, cmd: { spawn(): Entity; add<T>(entity: Entity, component: ComponentType<T>, data: T): void }, agent: Entity, conversation: Entity): void {
  const exists = world.query(AgentConversationLink).some((entity) => {
    const link = world.get(entity, AgentConversationLink);
    return !!link && link.agent === agent && link.conversation === conversation;
  });
  if (exists) return;
  const now = Date.now();
  const entity = cmd.spawn();
  cmd.add(entity, AgentConversationLink, { id: `acl${entity}`, agent, conversation, role: 'participant', createdAt: now, updatedAt: now });
}

function latestSystemPromptScopeLink(world: WorldReader, scopeKind: ConfigScopeKind, scopeId: string | undefined) {
  const entity = scopeLinkEntities(world, SystemPromptScopeLink, scopeKind, scopeId).at(-1);
  const link = entity === undefined ? undefined : world.get(entity, SystemPromptScopeLink);
  return entity !== undefined && link ? { entity, link } : undefined;
}

function latestModelProfileScopeLink(world: WorldReader, scopeKind: ConfigScopeKind, scopeId: string | undefined) {
  const entity = scopeLinkEntities(world, ModelProfileScopeLink, scopeKind, scopeId).at(-1);
  const link = entity === undefined ? undefined : world.get(entity, ModelProfileScopeLink);
  return entity !== undefined && link ? { entity, link } : undefined;
}

function scopeLinkEntities<T extends { scopeKind: ConfigScopeKind; scopeId?: string; role: 'active'; createdAt: number; updatedAt: number }>(world: WorldReader, component: ComponentType<T>, scopeKind: ConfigScopeKind, scopeId: string | undefined): Entity[] {
  return world.query(component).filter((entity) => {
    const link = world.get(entity, component);
    return !!link && link.role === 'active' && link.scopeKind === scopeKind && (scopeKind === 'global' ? link.scopeId === undefined : link.scopeId === scopeId);
  }).sort((left, right) => {
    const a = world.get(left, component)!;
    const b = world.get(right, component)!;
    return (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt) || left - right;
  });
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: ComponentType<T>, id: string): Entity | undefined {
  return world.query(component).find((entity) => world.get(entity, component)?.id === id);
}

function normalizeName(value: string | undefined, fallback: string): string { return value?.trim().replace(/\s+/g, ' ') || fallback; }
function normalizeText(value: string | undefined): string | undefined { const text = value?.trim(); return text || undefined; }
function normalizeKind(value: string | undefined, fallback: string): string { return value?.trim().replace(/\s+/g, '-').toLowerCase() || fallback; }
function systemPromptIdForScope(scopeKind: ConfigScopeKind, scopeId?: string): string { return `system-prompt:${scopeKind}:${scopeId ?? 'global'}`; }
function systemPromptScopeLinkId(scopeKind: ConfigScopeKind, scopeId?: string): string { return `system-prompt-scope:${scopeKind}:${scopeId ?? 'global'}`; }
function modelProfileIdForScope(scopeKind: ConfigScopeKind, scopeId?: string): string { return `model-profile:${scopeKind}:${scopeId ?? 'global'}`; }
function modelProfileScopeLinkId(scopeKind: ConfigScopeKind, scopeId?: string): string { return `model-profile-scope:${scopeKind}:${scopeId ?? 'global'}`; }
function defaultSystemPromptName(scopeKind: ConfigScopeKind): string { return `${scopeKind} System Prompt`; }
function defaultModelProfileName(scopeKind: ConfigScopeKind): string { return `${scopeKind} Model Profile`; }
