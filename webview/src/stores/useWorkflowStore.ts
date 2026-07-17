import { defineStore } from 'pinia';
import {
  createMessageId,
  type ConversationWorkflowSelectionRecord,
  type WorkflowRecord
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

export const DEFAULT_WORKFLOW_OPTION_ID = 'global';

function upsertById<T extends { id: string }>(list: T[], record: T): void {
  const index = list.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
}

function activeSelectionForConversation(conversationId: string): ConversationWorkflowSelectionRecord | undefined {
  const clientState = useClientStateStore();
  return clientState.conversationWorkflowSelections
    .filter((selection) => selection.conversationId === conversationId && selection.role === 'active')
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function workflowLabel(workflow: WorkflowRecord): string {
  return workflow.name.trim() || workflow.id;
}

function normalizeName(name: string, fallback = '新工作流'): string {
  return name.trim().replace(/\s+/g, ' ') || fallback;
}

function normalizeDescription(description: string | undefined): string | undefined {
  const text = description?.trim();
  return text ? text : undefined;
}

export function workflowRecordToPlain(record: WorkflowRecord): WorkflowRecord {
  return {
    id: record.id,
    name: record.name,
    ...(record.description ? { description: record.description } : {}),
    source: record.source,
    ...(record.icon ? { icon: record.icon } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export const useWorkflowStore = defineStore('workflow', {
  state: () => ({
    status: ''
  }),
  getters: {
    workflows(): WorkflowRecord[] {
      const clientState = useClientStateStore();
      return [...clientState.workflows].sort((left, right) => {
        const sourceOrder = Number(left.source === 'user') - Number(right.source === 'user');
        return sourceOrder || workflowLabel(left).localeCompare(workflowLabel(right), 'zh-CN') || left.id.localeCompare(right.id);
      });
    },
    editableWorkflows(): WorkflowRecord[] {
      return this.workflows;
    }
  },
  actions: {
    activeSelectionForConversation(conversationId: string): ConversationWorkflowSelectionRecord | undefined {
      return activeSelectionForConversation(conversationId);
    },
    activeWorkflowIdForConversation(conversationId: string): string {
      const selection = activeSelectionForConversation(conversationId);
      return selection?.scopeKind === 'workflow' && selection.workflowId ? selection.workflowId : DEFAULT_WORKFLOW_OPTION_ID;
    },
    activeWorkflowForConversation(conversationId: string): WorkflowRecord | undefined {
      const workflowId = this.activeWorkflowIdForConversation(conversationId);
      if (workflowId === DEFAULT_WORKFLOW_OPTION_ID) return undefined;
      return this.workflows.find((workflow) => workflow.id === workflowId);
    },
    selectDefault(conversationId: string): void {
      if (!conversationId) return;
      this.applyOptimisticSelection({ conversationId, scopeKind: 'global' });
      bridge.request(BridgeMessageType.ConversationWorkflowSelect, { conversationId, scopeKind: 'global' });
    },
    selectWorkflow(conversationId: string, workflowId: string): void {
      if (!conversationId || !workflowId || !this.workflows.some((workflow) => workflow.id === workflowId)) return;
      this.applyOptimisticSelection({ conversationId, scopeKind: 'workflow', workflowId });
      bridge.request(BridgeMessageType.ConversationWorkflowSelect, { conversationId, scopeKind: 'workflow', workflowId });
    },
    createWorkflow(name: string, description?: string): void {
      const normalizedName = normalizeName(name);
      this.status = '正在创建工作流...';
      bridge.request(BridgeMessageType.WorkflowCreate, {
        name: normalizedName,
        ...(normalizeDescription(description) ? { description: normalizeDescription(description) } : {})
      });
    },
    renameWorkflow(workflowId: string, name: string): void {
      const clientState = useClientStateStore();
      const workflow = clientState.workflows.find((candidate) => candidate.id === workflowId);
      if (!workflow) return;
      const nextName = normalizeName(name, workflow.name);
      workflow.name = nextName;
      workflow.updatedAt = Date.now();
      this.status = '正在重命名工作流...';
      bridge.request(BridgeMessageType.WorkflowUpdate, { workflowId, name: nextName });
    },
    updateWorkflowDescription(workflowId: string, description: string): void {
      const clientState = useClientStateStore();
      const workflow = clientState.workflows.find((candidate) => candidate.id === workflowId);
      if (!workflow) return;
      const nextDescription = normalizeDescription(description);
      if (nextDescription) workflow.description = nextDescription;
      else delete workflow.description;
      workflow.updatedAt = Date.now();
      this.status = '正在更新工作流描述...';
      bridge.request(BridgeMessageType.WorkflowUpdate, { workflowId, description: nextDescription ?? '' });
    },
    saveWorkflowRaw(record: WorkflowRecord): void {
      const clientState = useClientStateStore();
      const workflow = clientState.workflows.find((candidate) => candidate.id === record.id);
      if (!workflow) return;
      const nextName = normalizeName(record.name, workflow.name);
      const nextDescription = normalizeDescription(record.description);
      workflow.name = nextName;
      if (nextDescription) workflow.description = nextDescription;
      else delete workflow.description;
      if (record.icon) workflow.icon = record.icon;
      else delete workflow.icon;
      workflow.updatedAt = Date.now();
      this.status = '正在保存工作流原始数据...';
      bridge.request(BridgeMessageType.WorkflowUpdate, {
        workflowId: workflow.id,
        name: nextName,
        description: nextDescription ?? '',
        ...(record.icon ? { icon: record.icon } : {})
      });
    },
    deleteWorkflow(workflowId: string): void {
      const clientState = useClientStateStore();
      const workflow = clientState.workflows.find((candidate) => candidate.id === workflowId);
      if (!workflow || workflow.source === 'builtin') return;
      clientState.workflows = clientState.workflows.filter((candidate) => candidate.id !== workflowId);
      clientState.conversationWorkflowSelections = clientState.conversationWorkflowSelections.filter((selection) => selection.workflowId !== workflowId);
      this.status = '正在删除工作流...';
      bridge.request(BridgeMessageType.WorkflowDelete, { workflowId });
    },
    applyOptimisticSelection(payload: { conversationId: string; scopeKind: 'global' } | { conversationId: string; scopeKind: 'workflow'; workflowId: string }): void {
      const clientState = useClientStateStore();
      const now = Date.now();
      const existing = activeSelectionForConversation(payload.conversationId);
      const selection: ConversationWorkflowSelectionRecord = {
        id: payload.scopeKind === 'global'
          ? `conversation-workflow:global:${payload.conversationId}`
          : `conversation-workflow:workflow:${payload.conversationId}:${payload.workflowId}`,
        conversationId: payload.conversationId,
        scopeKind: payload.scopeKind,
        ...(payload.scopeKind === 'workflow' ? { workflowId: payload.workflowId } : {}),
        role: 'active',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      clientState.conversationWorkflowSelections = clientState.conversationWorkflowSelections.filter(
        (candidate) => !(candidate.conversationId === payload.conversationId && candidate.role === 'active')
      );
      upsertById(clientState.conversationWorkflowSelections, selection);
      this.status = payload.scopeKind === 'global' ? '已切换到默认工作流' : '已切换工作流';
    },
    createLocalWorkflowRecord(name: string): WorkflowRecord {
      const now = Date.now();
      return {
        id: `workflow:local:${createMessageId()}`,
        name: normalizeName(name),
        source: 'user',
        icon: 'list-details',
        createdAt: now,
        updatedAt: now
      };
    }
  }
});
