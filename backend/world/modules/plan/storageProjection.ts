import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { planReviewStateProjectionReads, projectPlanReviewState } from './stateProjection';

export const planReviewStorageStateContributor = defineStorageStateContributor({
  key: 'planReview',
  reads: planReviewStateProjectionReads,
  project: projectPlanReviewState
});
