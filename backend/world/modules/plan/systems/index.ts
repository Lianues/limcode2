import type { Scheduler } from '../../../../ecs/Scheduler';
import { PlanProposalDecisionSystem } from './PlanProposalDecisionSystem';
import { PlanReviewPolicyScopeSystem } from './PlanReviewPolicyScopeSystem';

export function registerPlanReviewSystems(scheduler: Scheduler): void {
  scheduler.addMany([PlanReviewPolicyScopeSystem, PlanProposalDecisionSystem]);
}
