import { defineStore } from 'pinia';
import { createMessageId, type AgentRecord, type ConversationAgentSelectionRecord } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

function agentLabel(agent: AgentRecord): string {
  return agent.name.trim() || agent.id;
}

function upsertById<T extends { id: string }>(items: T[], record: T): void {
  const index = items.findIndex((item) => item.id === record.id);
  if (index >= 0) items[index] = record;
  else items.push(record);
}

export const useAgentStore = defineStore('agent', {
  state: () => ({ status: '' }),
  getters: {
    agents(): AgentRecord[] {
      const clientState = useClientStateStore();
      return [...clientState.agents].sort((left, right) => {
        const sourceOrder = Number(left.source === 'user') - Number(right.source === 'user');
        return sourceOrder || agentLabel(left).localeCompare(agentLabel(right), 'zh-CN') || left.id.localeCompare(right.id);
      });
    },
    userAgents(): AgentRecord[] {
      return this.agents.filter((agent) => agent.source === 'user');
    }
  },
  actions: {
    activeAgentForConversation(conversationId: string): AgentRecord | undefined {
      const clientState = useClientStateStore();
      const selection = clientState.conversationAgentSelections
        .filter((item) => item.conversationId === conversationId && item.role === 'active')
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
      const fallbackLink = selection ? undefined : clientState.agentConversationLinks.find((link) => link.conversationId === conversationId && link.role === 'default') ?? clientState.agentConversationLinks.find((link) => link.conversationId === conversationId);
      return clientState.agents.find((agent) => agent.id === (selection?.agentId ?? fallbackLink?.agentId));
    },
    selectAgent(conversationId: string, agentId: string): void {
      if (!conversationId || !agentId) return;
      const clientState = useClientStateStore();
      if (!clientState.agents.some((agent) => agent.id === agentId)) return;
      const now = Date.now();
      const existing = clientState.conversationAgentSelections.find((selection) => selection.conversationId === conversationId && selection.role === 'active');
      const selection: ConversationAgentSelectionRecord = {
        id: existing?.id ?? `conversation-agent-local-${createMessageId()}`,
        conversationId,
        agentId,
        role: 'active',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      clientState.conversationAgentSelections = clientState.conversationAgentSelections.filter((item) => !(item.conversationId === conversationId && item.role === 'active'));
      upsertById(clientState.conversationAgentSelections, selection);
      bridge.request(BridgeMessageType.ConversationAgentSelect, { conversationId, agentId });
    },
    createAgent(name: string): void {
      const normalized = name.trim().replace(/\s+/g, ' ') || '新 Agent';
      this.status = '正在创建 Agent...';
      bridge.request(BridgeMessageType.AgentCreate, { name: normalized, kind: 'custom' });
    },
    renameAgent(agentId: string, name: string): void {
      const clientState = useClientStateStore();
      const agent = clientState.agents.find((item) => item.id === agentId);
      if (!agent) return;
      const nextName = name.trim().replace(/\s+/g, ' ') || agent.name;
      agent.name = nextName;
      this.status = '正在重命名 Agent...';
      bridge.request(BridgeMessageType.AgentUpdate, { agentId, name: nextName });
    },
    updateDescription(agentId: string, description: string): void {
      const clientState = useClientStateStore();
      const agent = clientState.agents.find((item) => item.id === agentId);
      if (!agent) return;
      const text = description.trim();
      if (text) agent.description = text;
      else delete agent.description;
      this.status = '正在更新 Agent 描述...';
      bridge.request(BridgeMessageType.AgentUpdate, { agentId, description: text });
    },
    deleteAgent(agentId: string): void {
      const clientState = useClientStateStore();
      const agent = clientState.agents.find((item) => item.id === agentId);
      if (!agent || agent.source === 'builtin') return;
      clientState.agents = clientState.agents.filter((item) => item.id !== agentId);
      clientState.conversationAgentSelections = clientState.conversationAgentSelections.filter((item) => item.agentId !== agentId);
      this.status = '正在删除 Agent...';
      bridge.request(BridgeMessageType.AgentDelete, { agentId });
    }
  }
});
