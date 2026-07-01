import { defineStore } from 'pinia';
import type { RuleFileRecord, RuleKind, RuleScope } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

function upsertById<T extends { id: string }>(list: T[], record: T): void {
  const index = list.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
}

export const useRulesStore = defineStore('rules', {
  getters: {
    ruleFiles(): RuleFileRecord[] {
      return useClientStateStore().ruleFiles;
    }
  },
  actions: {
    fileFor(scope: RuleScope, kind: RuleKind): RuleFileRecord | undefined {
      return this.ruleFiles.find((rule) => rule.scope === scope && rule.kind === kind);
    },
    /** 保存 AGENTS.md（仅 AGENTS 可写）。乐观更新 content/exists，后端落盘后再回流 reconcile。 */
    save(scope: RuleScope, content: string): void {
      const clientState = useClientStateStore();
      const existing = this.fileFor(scope, 'AGENTS');
      if (existing) {
        upsertById(clientState.ruleFiles, { ...existing, content, exists: true });
      }
      bridge.request(BridgeMessageType.RulesFileSave, { scope, content });
    },
    refresh(): void {
      bridge.request(BridgeMessageType.RulesCatalogRefresh, {});
    }
  }
});
