import { defineStore } from 'pinia';
import {
  createMessageId,
  type ConversationModeSelectionRecord,
  type ModeRecord
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

export const GLOBAL_MODE_OPTION_ID = 'global';
export const BUILTIN_PLAN_MODE_ID = 'builtin:plan';

function upsertById<T extends { id: string }>(list: T[], record: T): void {
  const index = list.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
}

function activeSelectionForConversation(conversationId: string): ConversationModeSelectionRecord | undefined {
  const clientState = useClientStateStore();
  return clientState.conversationModeSelections
    .filter((selection) => selection.conversationId === conversationId && selection.role === 'active')
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function modeLabel(mode: ModeRecord): string {
  return mode.name.trim() || mode.id;
}

function normalizeName(name: string, fallback = '新模式'): string {
  return name.trim().replace(/\s+/g, ' ') || fallback;
}

function normalizeDescription(description: string | undefined): string | undefined {
  const text = description?.trim();
  return text ? text : undefined;
}

export const useModeStore = defineStore('mode', {
  state: () => ({
    status: ''
  }),
  getters: {
    modes(): ModeRecord[] {
      const clientState = useClientStateStore();
      return [...clientState.modes].sort((left, right) => {
        const sourceOrder = Number(left.source === 'user') - Number(right.source === 'user');
        return sourceOrder || modeLabel(left).localeCompare(modeLabel(right)) || left.id.localeCompare(right.id);
      });
    },
    userEditableModes(): ModeRecord[] {
      return this.modes;
    },
    planMode(): ModeRecord | undefined {
      return this.modes.find((mode) => mode.id === BUILTIN_PLAN_MODE_ID);
    }
  },
  actions: {
    activeSelectionForConversation(conversationId: string): ConversationModeSelectionRecord | undefined {
      return activeSelectionForConversation(conversationId);
    },
    activeModeIdForConversation(conversationId: string): string {
      const selection = activeSelectionForConversation(conversationId);
      return selection?.scopeKind === 'mode' && selection.modeId ? selection.modeId : GLOBAL_MODE_OPTION_ID;
    },
    activeModeForConversation(conversationId: string): ModeRecord | undefined {
      const modeId = this.activeModeIdForConversation(conversationId);
      if (modeId === GLOBAL_MODE_OPTION_ID) return undefined;
      return this.modes.find((mode) => mode.id === modeId);
    },
    selectGlobal(conversationId: string): void {
      if (!conversationId) return;
      this.applyOptimisticSelection({ conversationId, scopeKind: 'global' });
      bridge.request(BridgeMessageType.ConversationModeSelect, { conversationId, scopeKind: 'global' });
    },
    selectMode(conversationId: string, modeId: string): void {
      if (!conversationId || !modeId || !this.modes.some((mode) => mode.id === modeId)) return;
      this.applyOptimisticSelection({ conversationId, scopeKind: 'mode', modeId });
      bridge.request(BridgeMessageType.ConversationModeSelect, { conversationId, scopeKind: 'mode', modeId });
    },
    createMode(name: string, description?: string): void {
      const normalizedName = normalizeName(name);
      this.status = '正在创建模式...';
      bridge.request(BridgeMessageType.ModeCreate, {
        name: normalizedName,
        ...(normalizeDescription(description) ? { description: normalizeDescription(description) } : {})
      });
    },
    renameMode(modeId: string, name: string): void {
      const clientState = useClientStateStore();
      const mode = clientState.modes.find((candidate) => candidate.id === modeId);
      if (!mode) return;
      const nextName = normalizeName(name, mode.name);
      mode.name = nextName;
      mode.updatedAt = Date.now();
      this.status = '正在重命名模式...';
      bridge.request(BridgeMessageType.ModeUpdate, { modeId, name: nextName });
    },
    updateModeDescription(modeId: string, description: string): void {
      const clientState = useClientStateStore();
      const mode = clientState.modes.find((candidate) => candidate.id === modeId);
      if (!mode) return;
      const nextDescription = normalizeDescription(description);
      if (nextDescription) mode.description = nextDescription;
      else delete mode.description;
      mode.updatedAt = Date.now();
      this.status = '正在更新模式描述...';
      bridge.request(BridgeMessageType.ModeUpdate, { modeId, description: nextDescription ?? '' });
    },
    deleteMode(modeId: string): void {
      const clientState = useClientStateStore();
      const mode = clientState.modes.find((candidate) => candidate.id === modeId);
      if (!mode || mode.source === 'builtin') return;
      clientState.modes = clientState.modes.filter((candidate) => candidate.id !== modeId);
      clientState.conversationModeSelections = clientState.conversationModeSelections.filter((selection) => selection.modeId !== modeId);
      this.status = '正在删除模式...';
      bridge.request(BridgeMessageType.ModeDelete, { modeId });
    },
    applyOptimisticSelection(payload: { conversationId: string; scopeKind: 'global' } | { conversationId: string; scopeKind: 'mode'; modeId: string }): void {
      const clientState = useClientStateStore();
      const now = Date.now();
      const existing = activeSelectionForConversation(payload.conversationId);
      const selection: ConversationModeSelectionRecord = {
        id: payload.scopeKind === 'global'
          ? `conversation-mode:global:${payload.conversationId}`
          : `conversation-mode:mode:${payload.conversationId}:${payload.modeId}`,
        conversationId: payload.conversationId,
        scopeKind: payload.scopeKind,
        ...(payload.scopeKind === 'mode' ? { modeId: payload.modeId } : {}),
        role: 'active',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      clientState.conversationModeSelections = clientState.conversationModeSelections.filter(
        (candidate) => !(candidate.conversationId === payload.conversationId && candidate.role === 'active')
      );
      upsertById(clientState.conversationModeSelections, selection);
      this.status = payload.scopeKind === 'global' ? '已切换到 Global' : '已切换模式';
    },
    createLocalModeRecord(name: string): ModeRecord {
      const now = Date.now();
      return {
        id: `mode:local:${createMessageId()}`,
        name: normalizeName(name),
        source: 'user',
        icon: 'list-details',
        createdAt: now,
        updatedAt: now
      };
    }
  }
});
