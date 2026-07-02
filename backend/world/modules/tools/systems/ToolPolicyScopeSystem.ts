import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Mode, ToolPolicy } from '../../mode/components';
import { ToolPolicyScopeLink, type ToolPolicyScopeLinkData } from '../components';
import { ToolEventType } from '../events';
import { ToolDefinitionsKey } from '../resources';
import type { ToolConfigRecord, ToolConfigValue, ToolPolicyScopeKind, ToolPolicySourceConfigRecord, ToolPolicyToolConfigRecord } from '../../../../../shared/protocol';

export const ToolPolicyScopeSystem = defineSystem({
  name: 'ToolPolicyScopeSystem',
  shouldRun(ctx) {
    return readEvents(ctx, ToolEventType.PolicyScopeSetRequested).length > 0
      || readEvents(ctx, ToolEventType.PolicyScopeClearRequested).length > 0;
  },
  access: {
    reads: { components: [Agent, AgentRun, Conversation, Mode, ToolPolicy, ToolPolicyScopeLink] },
    writes: { components: [ToolPolicy, ToolPolicyScopeLink], mutationMode: 'update' },
    resources: { read: [ToolDefinitionsKey] },
    events: { read: [ToolEventType.PolicyScopeSetRequested, ToolEventType.PolicyScopeClearRequested] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ToolEventType.PolicyScopeSetRequested)) {
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      const allowedTools = sanitizeAllowedTools(world, payload.allowedTools);
      const existing = findActiveScopeLink(world, payload.scopeKind, scope.scopeId);
      const now = Date.now();
      const policyName = payload.name?.trim() || defaultPolicyName(payload.scopeKind);
      const nextToolConfigs = payload.toolConfigs !== undefined ? sanitizeToolConfigs(world, payload.toolConfigs) : undefined;
      const nextSourceConfigs = payload.sourceConfigs !== undefined ? sanitizeSourceConfigs(world, payload.sourceConfigs) : undefined;

      if (existing) {
        const currentPolicy = world.get(existing.link.toolPolicy, ToolPolicy);
        if (currentPolicy) {
          cmd.add(existing.link.toolPolicy, ToolPolicy, {
            ...currentPolicy,
            name: policyName,
            allowedTools,
            ...(nextToolConfigs !== undefined ? { toolConfigs: nextToolConfigs } : {}),
            ...(nextSourceConfigs !== undefined ? { sourceConfigs: nextSourceConfigs } : {})
          });
          cmd.add(existing.entity, ToolPolicyScopeLink, { ...existing.link, updatedAt: now });
        }
        continue;
      }

      const policy = findToolPolicyById(world, policyIdForScope(payload.scopeKind, scope.scopeId)) ?? cmd.spawn();
      cmd.add(policy, ToolPolicy, {
        id: policyIdForScope(payload.scopeKind, scope.scopeId),
        name: policyName,
        allowedTools,
        ...(nextToolConfigs !== undefined && Object.keys(nextToolConfigs).length > 0 ? { toolConfigs: nextToolConfigs } : {}),
        ...(nextSourceConfigs !== undefined && Object.keys(nextSourceConfigs).length > 0 ? { sourceConfigs: nextSourceConfigs } : {})
      });

      const link = cmd.spawn();
      cmd.add(link, ToolPolicyScopeLink, {
        id: linkIdForScope(payload.scopeKind, scope.scopeId),
        scopeKind: payload.scopeKind,
        ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
        toolPolicy: policy,
        ...scope.data,
        role: 'active',
        createdAt: now,
        updatedAt: now
      });
    }

    for (const payload of readEvents(ctx, ToolEventType.PolicyScopeClearRequested)) {
      if (payload.scopeKind === 'global') continue;
      const scope = resolveScope(world, payload.scopeKind, payload.scopeId);
      if (!scope.ok) continue;
      for (const entity of findActiveScopeLinkEntities(world, payload.scopeKind, scope.scopeId)) {
        cmd.despawn(entity);
      }
    }
  }
});

interface ResolvedToolPolicyScope {
  ok: true;
  scopeId?: string;
  data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity; agentSystemId: string }>;
}

function sanitizeSourceConfigs(
  world: WorldReader,
  rawConfigs: Record<string, ToolPolicySourceConfigRecord> | undefined
): Record<string, ToolPolicySourceConfigRecord> {
  const mcpTools = (world.tryGetResource(ToolDefinitionsKey) ?? []).filter((tool) => tool.source?.kind === 'mcp' && tool.source.sourceId);
  const toolsBySource = new Map<string, Set<string>>();
  for (const tool of mcpTools) {
    const sourceId = tool.source?.sourceId;
    if (!sourceId) continue;
    const names = toolsBySource.get(sourceId) ?? new Set<string>();
    names.add(tool.name);
    toolsBySource.set(sourceId, names);
  }

  const result: Record<string, ToolPolicySourceConfigRecord> = {};
  for (const [rawSourceId, rawConfig] of Object.entries(rawConfigs ?? {})) {
    const sourceId = rawSourceId.trim();
    const sourceTools = toolsBySource.get(sourceId);
    if (!sourceId || !sourceTools) continue;
    const disabledTools = [...new Set(rawConfig.disabledTools ?? [])]
      .map((name) => name.trim())
      .filter((name) => sourceTools.has(name));
    result[sourceId] = {
      enabled: rawConfig.enabled === true,
      ...(disabledTools.length > 0 ? { disabledTools } : {})
    };
  }
  return result;
}

type ScopeResult = ResolvedToolPolicyScope | { ok: false };

function sanitizeAllowedTools(world: WorldReader, rawAllowedTools: readonly string[] | undefined): string[] {
  const toolNames = new Set((world.tryGetResource(ToolDefinitionsKey) ?? []).map((tool) => tool.name));
  const allowed: string[] = [];
  for (const rawName of rawAllowedTools ?? []) {
    const name = rawName.trim();
    if (!name || !toolNames.has(name) || allowed.includes(name)) continue;
    allowed.push(name);
  }
  return allowed;
}

function sanitizeToolConfigs(
  world: WorldReader,
  rawConfigs: Record<string, ToolPolicyToolConfigRecord> | undefined
): Record<string, ToolPolicyToolConfigRecord> {
  const definitions = world.tryGetResource(ToolDefinitionsKey) ?? [];
  const definitionsByName = new Map(definitions.map((tool) => [tool.name, tool]));
  const result: Record<string, ToolPolicyToolConfigRecord> = {};
  for (const [rawToolName, rawRecord] of Object.entries(rawConfigs ?? {})) {
    const toolName = rawToolName.trim();
    const definition = definitionsByName.get(toolName);
    if (!toolName || !definition || !isPlainRecord(rawRecord?.config)) continue;
    const allowedFields = new Set((definition.configSchema?.fields ?? []).map((field) => field.key));
    const config: ToolConfigRecord = {};
    for (const [key, value] of Object.entries(rawRecord.config)) {
      if (allowedFields.size > 0 && !allowedFields.has(key)) continue;
      if (isToolConfigValue(value)) config[key] = value;
    }
    const supportsChangeApply = definition.metadata?.supportsChangeApply === true;
    const display = sanitizeDisplayPolicy(rawRecord.display, definition.metadata?.supportsDiffPreview === true);
    const nextRecord: ToolPolicyToolConfigRecord = {
      config,
      ...(typeof rawRecord.autoApproveExecution === 'boolean' ? { autoApproveExecution: rawRecord.autoApproveExecution } : {}),
      ...(supportsChangeApply && typeof rawRecord.autoApplyChange === 'boolean' ? { autoApplyChange: rawRecord.autoApplyChange } : {}),
      ...(supportsChangeApply ? normalizedAutoApplyChangeDelay(rawRecord.autoApplyChangeDelaySeconds) : {}),
      ...(typeof rawRecord.autoSubmitResult === 'boolean' ? { autoSubmitResult: rawRecord.autoSubmitResult } : {}),
      ...(display ? { display } : {})
    };
    if (
      Object.keys(config).length > 0
      || nextRecord.autoApproveExecution !== undefined
      || nextRecord.autoApplyChange !== undefined
      || nextRecord.autoApplyChangeDelaySeconds !== undefined
      || nextRecord.autoSubmitResult !== undefined
      || nextRecord.display !== undefined
    ) result[toolName] = nextRecord;
  }
  return result;
}

function normalizedAutoApplyChangeDelay(value: unknown): { autoApplyChangeDelaySeconds?: number } {
  if (typeof value !== 'number' || !Number.isFinite(value)) return {};
  return { autoApplyChangeDelaySeconds: Math.min(600, Math.max(0, Math.floor(value))) };
}

function sanitizeDisplayPolicy(value: unknown, supportsDiffPreview: boolean): { autoExpand?: boolean; autoOpenDiffPreview?: boolean } | undefined {
  if (!isPlainRecord(value)) return undefined;
  const display = {
    ...(typeof value.autoExpand === 'boolean' ? { autoExpand: value.autoExpand } : {}),
    ...(supportsDiffPreview && typeof value.autoOpenDiffPreview === 'boolean' ? { autoOpenDiffPreview: value.autoOpenDiffPreview } : {})
  };
  return Object.keys(display).length > 0 ? display : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isToolConfigValue(value: unknown): value is ToolConfigValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every((item) => isToolConfigValue(item));
  return isPlainRecord(value) && Object.values(value).every((item) => isToolConfigValue(item));
}

function resolveScope(world: WorldReader, scopeKind: ToolPolicyScopeKind, rawScopeId: string | undefined): ScopeResult {
  const scopeId = rawScopeId?.trim();
  switch (scopeKind) {
    case 'global':
      return { ok: true, data: {} };
    case 'conversation': {
      const conversation = scopeId ? findByRecordId(world, Conversation, scopeId) : undefined;
      return conversation === undefined ? { ok: false } : { ok: true, scopeId, data: { conversation } };
    }
    case 'agent': {
      const agent = scopeId ? findByRecordId(world, Agent, scopeId) : undefined;
      return agent === undefined ? { ok: false } : { ok: true, scopeId, data: { agent } };
    }
    case 'mode': {
      const mode = scopeId ? findByRecordId(world, Mode, scopeId) : undefined;
      return mode === undefined ? { ok: false } : { ok: true, scopeId, data: { mode } };
    }
    case 'run': {
      const run = scopeId ? findByRecordId(world, AgentRun, scopeId) : undefined;
      return run === undefined ? { ok: false } : { ok: true, scopeId, data: { run } };
    }
    case 'agentSystem':
      return scopeId ? { ok: true, scopeId, data: { agentSystemId: scopeId } } : { ok: false };
  }
}

function findActiveScopeLink(world: WorldReader, scopeKind: ToolPolicyScopeKind, scopeId: string | undefined): { entity: Entity; link: ToolPolicyScopeLinkData } | undefined {
  const entities = findActiveScopeLinkEntities(world, scopeKind, scopeId);
  const entity = entities[entities.length - 1];
  const link = entity === undefined ? undefined : world.get(entity, ToolPolicyScopeLink);
  return entity === undefined || !link ? undefined : { entity, link };
}

function findActiveScopeLinkEntities(world: WorldReader, scopeKind: ToolPolicyScopeKind, scopeId: string | undefined): Entity[] {
  return world
    .query(ToolPolicyScopeLink)
    .filter((entity) => {
      const link = world.get(entity, ToolPolicyScopeLink);
      return !!link && link.role === 'active' && link.scopeKind === scopeKind && scopeIdForLink(world, link) === normalizedScopeId(scopeKind, scopeId);
    })
    .sort((left, right) => {
      const leftLink = world.get(left, ToolPolicyScopeLink)!;
      const rightLink = world.get(right, ToolPolicyScopeLink)!;
      return (leftLink.updatedAt || leftLink.createdAt) - (rightLink.updatedAt || rightLink.createdAt) || left - right;
    });
}

function scopeIdForLink(world: WorldReader, link: ToolPolicyScopeLinkData): string | undefined {
  if (link.scopeKind === 'global') return undefined;
  if (link.scopeId) return link.scopeId;
  switch (link.scopeKind) {
    case 'conversation': return link.conversation !== undefined ? world.get(link.conversation, Conversation)?.id : undefined;
    case 'agent': return link.agent !== undefined ? world.get(link.agent, Agent)?.id : undefined;
    case 'mode': return link.mode !== undefined ? world.get(link.mode, Mode)?.id : undefined;
    case 'run': return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
    case 'agentSystem': return link.agentSystemId;
  }
}

function normalizedScopeId(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined): string | undefined {
  return scopeKind === 'global' ? undefined : scopeId;
}

function policyIdForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined): string {
  return `tool-policy:${scopeKind}:${scopeId ?? 'global'}`;
}

function linkIdForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined): string {
  return `tool-policy-scope:${scopeKind}:${scopeId ?? 'global'}`;
}

function defaultPolicyName(scopeKind: ToolPolicyScopeKind): string {
  switch (scopeKind) {
    case 'global': return '全局默认工具策略';
    case 'conversation': return '对话工具策略';
    case 'agent': return 'Agent 工具策略';
    case 'agentSystem': return '多 Agent 系统工具策略';
    case 'mode': return '模式工具策略';
    case 'run': return '运行工具策略';
  }
}

function findToolPolicyById(world: WorldReader, id: string): Entity | undefined {
  return findByRecordId(world, ToolPolicy, id);
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: { id: symbol }, id: string): Entity | undefined {
  return world.query(component as never).find((entity) => (world.get(entity, component as never) as T | undefined)?.id === id);
}
