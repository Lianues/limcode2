import type { Scheduler } from '../../../../ecs/Scheduler';
import { PlanProposalDecisionSystem } from './PlanProposalDecisionSystem';

export function registerPlanReviewSystems(scheduler: Scheduler): void {
  scheduler.addMany([PlanProposalDecisionSystem]);
}
