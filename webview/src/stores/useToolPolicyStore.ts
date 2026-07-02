import { defineStore } from 'pinia';
import type {
  ToolConfigRecord,
  ToolConfigValue,
  ToolDefinitionRecord,
  ToolPolicyRecord,
  ToolPolicySourceConfigRecord,
  ToolPolicyScopeKind,
  ToolPolicyScopeLinkRecord,
  ToolPolicyScopeSetPayload,
  ToolPolicyToolConfigRecord
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

export interface ToolPolicyResolution {
  policy?: ToolPolicyRecord;
  link?: ToolPolicyScopeLinkRecord;
  inheritedFrom?: ToolPolicyScopeKind;
}

function scopeIdFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): string | undefined {
  return scopeKind === 'global' ? undefined : scopeId?.trim();
}

function scopeLinkMatches(link: ToolPolicyScopeLinkRecord, scopeKind: ToolPolicyScopeKind, scopeId?: string): boolean {
  return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId);
}

function latestLink(links: ToolPolicyScopeLinkRecord[]): ToolPolicyScopeLinkRecord | undefined {
  return [...links].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function policyIdForScope(scopeKind: ToolPolicyScopeKind, scopeId?: string): string {
  return `tool-policy:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function linkIdForScope(scopeKind: ToolPolicyScopeKind, scopeId?: string): string {
  return `tool-policy-scope:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
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

function cloneToolConfigs(toolConfigs: Record<string, ToolPolicyToolConfigRecord> | undefined): Record<string, ToolPolicyToolConfigRecord> | undefined {
  if (!toolConfigs) return undefined;
  const cloned: Record<string, ToolPolicyToolConfigRecord> = {};
  for (const [toolName, record] of Object.entries(toolConfigs)) {
    cloned[toolName] = {
      config: cloneToolConfigRecord(record.config),
      ...(typeof record.autoApproveExecution === 'boolean' ? { autoApproveExecution: record.autoApproveExecution } : {}),
      ...(typeof record.autoApplyChange === 'boolean' ? { autoApplyChange: record.autoApplyChange } : {}),
      ...(typeof record.autoApplyChangeDelaySeconds === 'number' ? { autoApplyChangeDelaySeconds: record.autoApplyChangeDelaySeconds } : {}),
      ...(typeof record.autoSubmitResult === 'boolean' ? { autoSubmitResult: record.autoSubmitResult } : {}),
      ...(record.display ? { display: { ...record.display } } : {})
    };
  }
  return cloned;
}

function cloneSourceConfigs(sourceConfigs: Record<string, ToolPolicySourceConfigRecord> | undefined): Record<string, ToolPolicySourceConfigRecord> | undefined {
  if (!sourceConfigs) return undefined;
  const cloned: Record<string, ToolPolicySourceConfigRecord> = {};
  for (const [sourceId, record] of Object.entries(sourceConfigs)) {
    cloned[sourceId] = {
      enabled: record.enabled === true,
      ...(record.disabledTools?.length ? { disabledTools: [...record.disabledTools] } : {})
    };
  }
  return cloned;
}

function cloneToolConfigRecord(config: ToolConfigRecord | undefined): ToolConfigRecord {
  const cloned: ToolConfigRecord = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    const next = cloneToolConfigValue(value as ToolConfigValue | undefined);
    if (next !== undefined) cloned[key] = next;
  }
  return cloned;
}

function cloneToolConfigValue(value: ToolConfigValue | undefined): ToolConfigValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item) => cloneToolConfigValue(item as ToolConfigValue | undefined) ?? null) as ToolConfigValue;
  }
  if (typeof value === 'object') {
    const cloned: Record<string, ToolConfigValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, ToolConfigValue | undefined>)) {
      const next = cloneToolConfigValue(child);
      if (next !== undefined) cloned[key] = next;
    }
    return cloned;
  }
  return undefined;
}

function upsertById<T extends { id: string }>(list: T[], record: T): void {
  const index = list.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
}

export const useToolPolicyStore = defineStore('toolPolicy', {
  state: () => ({}),
  getters: {
    toolDefinitions(): ToolDefinitionRecord[] {
      const clientState = useClientStateStore();
      return [...clientState.toolDefinitions].sort((left, right) => left.name.localeCompare(right.name));
    },
    toolDefinitionByName(): Map<string, ToolDefinitionRecord> {
      const clientState = useClientStateStore();
      return new Map(clientState.toolDefinitions.map((tool) => [tool.name, tool]));
    }
  },
  actions: {
    localPolicyFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): ToolPolicyResolution {
      const clientState = useClientStateStore();
      const link = latestLink(clientState.toolPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, scopeId)));
      const policy = clientState.toolPolicies.find((candidate) => candidate.id === link?.toolPolicyId);
      return { ...(policy ? { policy } : {}), ...(link ? { link } : {}) };
    },
    effectivePolicyFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): ToolPolicyResolution {
      const local = this.localPolicyFor(scopeKind, scopeId);
      if (local.policy) return local;

      const clientState = useClientStateStore();
      void clientState;
      if (scopeKind !== 'global') {
        const global = this.localPolicyFor('global');
        if (global.policy) return { ...global, inheritedFrom: 'global' };
      }

      const fallback = clientState.toolPolicies[0];
      return fallback ? { policy: fallback, inheritedFrom: 'global' } : {};
    },
    setPolicyForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, allowedTools: string[], name?: string, toolConfigs?: Record<string, ToolPolicyToolConfigRecord>, sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>): void {
      const clientState = useClientStateStore();
      const validNames = new Set(clientState.toolDefinitions.map((tool) => tool.name));
      const sanitized = allowedTools
        .map((tool) => tool.trim())
        .filter((tool, index, list) => !!tool && validNames.has(tool) && list.indexOf(tool) === index);

      const plainToolConfigs = cloneToolConfigs(toolConfigs);
      const plainSourceConfigs = cloneSourceConfigs(sourceConfigs);
      this.applyOptimisticPolicyScopeSet(scopeKind, scopeId, sanitized, name, plainToolConfigs, plainSourceConfigs);

      const payload: ToolPolicyScopeSetPayload = {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        ...(name?.trim() ? { name: name.trim() } : {}),
        allowedTools: sanitized,
        ...(plainToolConfigs !== undefined ? { toolConfigs: plainToolConfigs } : {}),
        ...(plainSourceConfigs !== undefined ? { sourceConfigs: plainSourceConfigs } : {})
      };
      bridge.request(BridgeMessageType.ToolPolicyScopeSet, payload);
    },
    clearPolicyScope(scopeKind: ToolPolicyScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.toolPolicyScopeLinks = clientState.toolPolicyScopeLinks.filter((link) => !scopeLinkMatches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.ToolPolicyScopeClear, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {})
      });
    },
    applyOptimisticPolicyScopeSet(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, allowedTools: string[], name?: string, toolConfigs?: Record<string, ToolPolicyToolConfigRecord>, sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>): void {
      const clientState = useClientStateStore();
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      const existingLink = latestLink(clientState.toolPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, normalizedScopeId)));
      const existingPolicy = clientState.toolPolicies.find((policy) => policy.id === existingLink?.toolPolicyId);
      const policyId = existingLink?.toolPolicyId ?? policyIdForScope(scopeKind, normalizedScopeId);
      const now = Date.now();
      const nextPolicy: ToolPolicyRecord = {
        id: policyId,
        name: name?.trim() || existingPolicy?.name || defaultPolicyName(scopeKind),
        allowedTools,
        ...(toolConfigs !== undefined
          ? { toolConfigs: cloneToolConfigs(toolConfigs) ?? {} }
          : existingPolicy?.toolConfigs
            ? { toolConfigs: cloneToolConfigs(existingPolicy.toolConfigs) ?? {} }
            : {}),
        ...(sourceConfigs !== undefined
          ? { sourceConfigs: cloneSourceConfigs(sourceConfigs) ?? {} }
          : existingPolicy?.sourceConfigs
            ? { sourceConfigs: cloneSourceConfigs(existingPolicy.sourceConfigs) ?? {} }
            : {})
      };
      upsertById(clientState.toolPolicies, nextPolicy);

      const nextLink: ToolPolicyScopeLinkRecord = {
        id: existingLink?.id ?? linkIdForScope(scopeKind, normalizedScopeId),
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        toolPolicyId: policyId,
        role: 'active',
        createdAt: existingLink?.createdAt ?? now,
        updatedAt: now
      };
      upsertById(clientState.toolPolicyScopeLinks, nextLink);
    }
  }
});
