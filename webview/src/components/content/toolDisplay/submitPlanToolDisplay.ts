import { IconClipboardList } from '@tabler/icons-vue';
import { submitPlanOutputFromResult, submitPlanRequestFromArgs } from '@shared/planReview';
import type { ToolDisplayResolver } from './types';

export const submitPlanToolDisplay: ToolDisplayResolver = (context) => {
  const request = submitPlanRequestFromArgs(context.args)
    ?? submitPlanRequestFromArgs(context.toolCall?.args);
  if (!request) return undefined;

  const proposalId = proposalIdFromProgress(context.toolCall?.progress)
    ?? submitPlanOutputFromResult(context.toolCall?.result)?.proposalId;

  return {
    headerIcon: IconClipboardList,
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

function proposalIdFromProgress(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).planProposalId;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}
