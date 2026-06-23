import { defineStore } from 'pinia';
import {
  BridgeMessageType,
  type ConfigScopeKind,
  type PromptPlaceholderRecord,
  type RuntimeContextRecord,
  type RuntimeContextScopeLinkRecord,
  type RuntimeContextSnapshotRecord
} from '@shared/protocol';
import { bridge } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

function scopeIdFor(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined { return scopeKind === 'global' ? undefined : scopeId?.trim(); }
function matches(link: RuntimeContextScopeLinkRecord, scopeKind: ConfigScopeKind, scopeId?: string): boolean { return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId); }
function latest<T extends { createdAt: number; updatedAt: number; id: string }>(items: T[]): T | undefined { return [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]; }
function sortPlaceholders(items: PromptPlaceholderRecord[]): PromptPlaceholderRecord[] { return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)); }

export const useRuntimeContextStore = defineStore('runtimeContext', {
  state: () => ({ status: '' }),
  getters: {
    runtimePlaceholders(): PromptPlaceholderRecord[] {
      return sortPlaceholders(useClientStateStore().promptPlaceholders.filter((item) => item.target === 'runtimeContext'));
    }
  },
  actions: {
    localContextFor(scopeKind: ConfigScopeKind, scopeId?: string): { runtimeContext?: RuntimeContextRecord; link?: RuntimeContextScopeLinkRecord } {
      const clientState = useClientStateStore();
      const link = latest(clientState.runtimeContextScopeLinks.filter((item) => matches(item, scopeKind, scopeId)));
      const runtimeContext = clientState.runtimeContexts.find((item) => item.id === link?.runtimeContextId);
      return { ...(runtimeContext ? { runtimeContext } : {}), ...(link ? { link } : {}) };
    },
    activeSnapshotForConversation(conversationId?: string): RuntimeContextSnapshotRecord | undefined {
      if (!conversationId) return undefined;
      const clientState = useClientStateStore();
      const link = latest(clientState.conversationRuntimeContextSnapshotLinks.filter((item) => item.conversationId === conversationId && item.role === 'active'));
      return clientState.runtimeContextSnapshots.find((item) => item.id === link?.runtimeContextSnapshotId);
    },
    setContextForScope(scopeKind: ConfigScopeKind, scopeId: string | undefined, template: string, name?: string): void {
      bridge.request(BridgeMessageType.RuntimeContextScopeSet, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        template,
        ...(name?.trim() ? { name: name.trim() } : {})
      });
      this.status = '正在保存运行时模板...';
    },
    clearContextScope(scopeKind: ConfigScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.runtimeContextScopeLinks = clientState.runtimeContextScopeLinks.filter((link) => !matches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.RuntimeContextScopeClear, { scopeKind, ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}) });
    },
    refreshConversationSnapshot(conversationId?: string): void {
      if (!conversationId) return;
      bridge.request(BridgeMessageType.RuntimeContextRefresh, { conversationId });
      this.status = '正在刷新运行时快照...';
    },
    clearConversationSnapshot(conversationId?: string): void {
      if (!conversationId) return;
      const clientState = useClientStateStore();
      clientState.conversationRuntimeContextSnapshotLinks = clientState.conversationRuntimeContextSnapshotLinks.filter((link) => link.conversationId !== conversationId);
      bridge.request(BridgeMessageType.RuntimeContextSnapshotClear, { conversationId });
      this.status = '已清除运行时快照。';
    }
  }
});
