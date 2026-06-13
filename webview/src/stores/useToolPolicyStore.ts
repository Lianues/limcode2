import { defineStore } from 'pinia';
import type { ToolDefinitionRecord, ToolPolicyRecord, ToolPolicyScopeKind, ToolPolicyScopeLinkRecord } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

export interface ToolPolicyResolution {
  policy?: ToolPolicyRecord;
  link?: ToolPolicyScopeLinkRecord;
  inheritedFrom?: ToolPolicyScopeKind | 'modeLegacy' | 'runLegacy';
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
      if (scopeKind === 'mode' && scopeId) {
        const legacyLink = clientState.modeToolPolicyLinks.find((link) => link.modeId === scopeId && link.role === 'active');
        const legacyPolicy = clientState.toolPolicies.find((policy) => policy.id === legacyLink?.toolPolicyId);
        if (legacyPolicy) return { policy: legacyPolicy, inheritedFrom: 'modeLegacy' };
      }
      if (scopeKind === 'run' && scopeId) {
        const legacyLink = clientState.runToolPolicyLinks.find((link) => link.runId === scopeId && link.role === 'active');
        const legacyPolicy = clientState.toolPolicies.find((policy) => policy.id === legacyLink?.toolPolicyId);
        if (legacyPolicy) return { policy: legacyPolicy, inheritedFrom: 'runLegacy' };
      }

      if (scopeKind !== 'global') {
        const global = this.localPolicyFor('global');
        if (global.policy) return { ...global, inheritedFrom: 'global' };
      }

      const fallback = clientState.toolPolicies[0];
      return fallback ? { policy: fallback, inheritedFrom: 'global' } : {};
    },
    setPolicyForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, allowedTools: string[], name?: string): void {
      const validNames = new Set(useClientStateStore().toolDefinitions.map((tool) => tool.name));
      const sanitized = allowedTools
        .map((tool) => tool.trim())
        .filter((tool, index, list) => !!tool && validNames.has(tool) && list.indexOf(tool) === index);
      bridge.request(BridgeMessageType.ToolPolicyScopeSet, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        ...(name?.trim() ? { name: name.trim() } : {}),
        allowedTools: sanitized
      });
    },
    clearPolicyScope(scopeKind: ToolPolicyScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      bridge.request(BridgeMessageType.ToolPolicyScopeClear, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {})
      });
    }
  }
});
