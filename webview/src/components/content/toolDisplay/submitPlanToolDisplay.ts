import { IconClipboardList, IconExternalLink } from '@tabler/icons-vue';
import { submitPlanOutputFromResult, submitPlanRequestFromArgs } from '@shared/planReview';
import { bridge, BridgeMessageType } from '@webview/transport';
import type { ToolDisplayResolver, ToolHeaderAction } from './types';

export const submitPlanToolDisplay: ToolDisplayResolver = (context) => {
  const request = submitPlanRequestFromArgs(context.args)
    ?? submitPlanRequestFromArgs(context.toolCall?.args);
  if (!request) return undefined;

  const proposalId = proposalIdFromProgress(context.toolCall?.progress)
    ?? submitPlanOutputFromResult(context.toolCall?.result)?.proposalId;

  return {
    headerIcon: IconClipboardList,
    headerActions: planHeaderActions(context.currentConversationId, context.toolCall?.id, proposalId),
    inputSections: [{
      kind: 'input',
      title: context.toolCall?.status === 'awaiting_user_input' ? '等待审批 Plan' : 'Plan 审批',
      planProposal: {
        request,
        ...(proposalId ? { proposalId } : {}),
        ...(context.toolCall ? { toolCall: context.toolCall } : {})
      }
    }],
    outputSections: []
  };
};

function planHeaderActions(conversationId: string | undefined, toolCallId: string | undefined, planProposalId: string | undefined): ToolHeaderAction[] {
  return [{
    id: `open-plan-detail-${toolCallId ?? planProposalId ?? 'pending'}`,
    label: '全展开',
    title: toolCallId || planProposalId ? '在独立标签页完整查看并审批 Plan' : '等待 Plan 工具调用创建后可打开完整视图',
    icon: IconExternalLink,
    disabled: !toolCallId && !planProposalId,
    invoke: () => {
      if (!toolCallId && !planProposalId) return;
      bridge.request(BridgeMessageType.PlanProposalOpen, {
        ...(conversationId ? { conversationId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        ...(planProposalId ? { planProposalId } : {}),
        title: 'Plan 详情'
      });
    }
  }];
}

function proposalIdFromProgress(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).planProposalId;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}
