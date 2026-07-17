import { defineClientStateContributor } from '../../clientSync/contributors';
import { planReviewStateProjectionReads, projectPlanReviewState } from './stateProjection';

export const projectPlanReviewClientState = projectPlanReviewState;

export const planReviewClientSyncContributor = defineClientStateContributor({
  key: 'planReview',
  tables: [
    'planReviewPolicies',
    'planReviewPolicyScopeLinks',
    'planProposals',
    'runPlanProposalLinks'
  ],
  reads: planReviewStateProjectionReads,
  project: projectPlanReviewClientState,
  worker: {
    modulePath: '../world/modules/plan/clientSync',
    projectExport: 'projectPlanReviewClientState'
  }
});
