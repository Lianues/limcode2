import { defineStore } from 'pinia';
import { type ConfigScopeKind, type PromptPlaceholderRecord, type SystemPromptRecord, type SystemPromptScopeLinkRecord } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

interface PendingSystemPromptSave {
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  text: string;
  requestedAt: number;
}

interface SystemPromptStoreState {
  status: string;
  pendingSave?: PendingSystemPromptSave;
}

function scopeIdFor(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined { return scopeKind === 'global' ? undefined : scopeId?.trim(); }
function matches(link: SystemPromptScopeLinkRecord, scopeKind: ConfigScopeKind, scopeId?: string): boolean { return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId); }
function latest<T extends { createdAt: number; updatedAt: number; id: string }>(items: T[]): T | undefined { return [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]; }
function sortPlaceholders(items: PromptPlaceholderRecord[]): PromptPlaceholderRecord[] { return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)); }

export const useSystemPromptStore = defineStore('systemPrompt', {
  state: (): SystemPromptStoreState => ({ status: '' }),
  getters: {
    systemPlaceholders(): PromptPlaceholderRecord[] {
      return sortPlaceholders(useClientStateStore().promptPlaceholders.filter((item) => item.target === 'systemPrompt'));
    }
  },
  actions: {
    localPromptFor(scopeKind: ConfigScopeKind, scopeId?: string): { prompt?: SystemPromptRecord; link?: SystemPromptScopeLinkRecord } {
      const clientState = useClientStateStore();
      const link = latest(clientState.systemPromptScopeLinks.filter((item) => matches(item, scopeKind, scopeId)));
      const prompt = clientState.systemPrompts.find((item) => item.id === link?.systemPromptId);
      return { ...(prompt ? { prompt } : {}), ...(link ? { link } : {}) };
    },
    setPromptForScope(scopeKind: ConfigScopeKind, scopeId: string | undefined, text: string, name?: string): void {
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      if (scopeKind !== 'global' && !normalizedScopeId) {
        this.status = '缺少 Prompt 作用域，无法保存。';
        return;
      }

      const normalizedText = text.trim();
      if (!normalizedText) {
        this.status = scopeKind === 'global'
          ? 'Global Prompt 不能为空。'
          : 'Prompt 内容为空；若要继承上级配置，请点击“恢复继承”。';
        return;
      }

      const requestedAt = Date.now();
      this.pendingSave = { scopeKind, ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}), text: normalizedText, requestedAt };
      bridge.request(BridgeMessageType.SystemPromptScopeSet, {
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        text: normalizedText,
        ...(name?.trim() ? { name: name.trim() } : {})
      });
      this.status = '正在保存 Prompt...';
    },
    clearPromptScope(scopeKind: ConfigScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.systemPromptScopeLinks = clientState.systemPromptScopeLinks.filter((link) => !matches(link, scopeKind, scopeId));
      this.pendingSave = undefined;
      this.status = '已恢复继承';
      bridge.request(BridgeMessageType.SystemPromptScopeClear, { scopeKind, ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}) });
    },
    reconcilePendingSave(): void {
      const pending = this.pendingSave;
      if (!pending) return;
      const local = this.localPromptFor(pending.scopeKind, pending.scopeId);
      if (!local.prompt || !local.link) return;
      if (local.prompt.text.trim() !== pending.text) return;
      if (local.link.updatedAt < pending.requestedAt) return;
      this.pendingSave = undefined;
      this.status = 'Prompt 已同步';
    }
  }
});
