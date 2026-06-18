import { defineStore } from 'pinia';
import { type ConfigScopeKind, type SystemPromptRecord, type SystemPromptScopeLinkRecord } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

function scopeIdFor(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined { return scopeKind === 'global' ? undefined : scopeId?.trim(); }
function matches(link: SystemPromptScopeLinkRecord, scopeKind: ConfigScopeKind, scopeId?: string): boolean { return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId); }
function latest<T extends { createdAt: number; updatedAt: number; id: string }>(items: T[]): T | undefined { return [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]; }

export const useSystemPromptStore = defineStore('systemPrompt', {
  state: () => ({ status: '' }),
  actions: {
    localPromptFor(scopeKind: ConfigScopeKind, scopeId?: string): { prompt?: SystemPromptRecord; link?: SystemPromptScopeLinkRecord } {
      const clientState = useClientStateStore();
      const link = latest(clientState.systemPromptScopeLinks.filter((item) => matches(item, scopeKind, scopeId)));
      const prompt = clientState.systemPrompts.find((item) => item.id === link?.systemPromptId);
      return { ...(prompt ? { prompt } : {}), ...(link ? { link } : {}) };
    },
    setPromptForScope(scopeKind: ConfigScopeKind, scopeId: string | undefined, text: string, name?: string): void {
      bridge.request(BridgeMessageType.SystemPromptScopeSet, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        text,
        ...(name?.trim() ? { name: name.trim() } : {})
      });
      this.status = '正在保存 Prompt...';
    },
    clearPromptScope(scopeKind: ConfigScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.systemPromptScopeLinks = clientState.systemPromptScopeLinks.filter((link) => !matches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.SystemPromptScopeClear, { scopeKind, ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}) });
    }
  }
});
