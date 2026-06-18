import { defineStore } from 'pinia';
import { type ConfigScopeKind, type LlmProviderKind, type ModelProfileRecord, type ModelProfileScopeLinkRecord } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

function scopeIdFor(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined { return scopeKind === 'global' ? undefined : scopeId?.trim(); }
function matches(link: ModelProfileScopeLinkRecord, scopeKind: ConfigScopeKind, scopeId?: string): boolean { return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId); }
function latest<T extends { createdAt: number; updatedAt: number; id: string }>(items: T[]): T | undefined { return [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]; }

export const useModelProfileStore = defineStore('modelProfile', {
  state: () => ({ status: '' }),
  actions: {
    localProfileFor(scopeKind: ConfigScopeKind, scopeId?: string): { profile?: ModelProfileRecord; link?: ModelProfileScopeLinkRecord } {
      const clientState = useClientStateStore();
      const link = latest(clientState.modelProfileScopeLinks.filter((item) => matches(item, scopeKind, scopeId)));
      const profile = clientState.modelProfiles.find((item) => item.id === link?.modelProfileId);
      return { ...(profile ? { profile } : {}), ...(link ? { link } : {}) };
    },
    setProfileForScope(scopeKind: ConfigScopeKind, scopeId: string | undefined, input: { name?: string; providerConfigId?: string; provider?: LlmProviderKind; model: string }): void {
      bridge.request(BridgeMessageType.ModelProfileScopeSet, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.providerConfigId?.trim() ? { providerConfigId: input.providerConfigId.trim() } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        model: input.model
      });
      this.status = '正在保存模型配置...';
    },
    clearProfileScope(scopeKind: ConfigScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.modelProfileScopeLinks = clientState.modelProfileScopeLinks.filter((link) => !matches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.ModelProfileScopeClear, { scopeKind, ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}) });
    }
  }
});
