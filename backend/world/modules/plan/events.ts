import type { PlanProposalDecisionPayload, PlanReviewPolicyScopeClearPayload, PlanReviewPolicyScopeSetPayload } from '../../../../shared/protocol';

export const PlanReviewEventType = {
  PolicyScopeSetRequested: 'planReview:policyScopeSetRequested',
  PolicyScopeClearRequested: 'planReview:policyScopeClearRequested',
  ProposalApproveRequested: 'planReview:proposalApproveRequested',
  ProposalChangesRequested: 'planReview:proposalChangesRequested',
  ProposalRejectRequested: 'planReview:proposalRejectRequested'
} as const;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'planReview:policyScopeSetRequested': PlanReviewPolicyScopeSetPayload;
    'planReview:policyScopeClearRequested': PlanReviewPolicyScopeClearPayload;
    'planReview:proposalApproveRequested': PlanProposalDecisionPayload;
    'planReview:proposalChangesRequested': PlanProposalDecisionPayload;
    'planReview:proposalRejectRequested': PlanProposalDecisionPayload;
  }
}
