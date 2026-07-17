import type { PlanProposalDecisionPayload } from '../../../../shared/protocol';

export const PlanReviewEventType = {
  ProposalApproveRequested: 'planReview:proposalApproveRequested',
  ProposalChangesRequested: 'planReview:proposalChangesRequested',
  ProposalRejectRequested: 'planReview:proposalRejectRequested'
} as const;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'planReview:proposalApproveRequested': PlanProposalDecisionPayload;
    'planReview:proposalChangesRequested': PlanProposalDecisionPayload;
    'planReview:proposalRejectRequested': PlanProposalDecisionPayload;
  }
}
