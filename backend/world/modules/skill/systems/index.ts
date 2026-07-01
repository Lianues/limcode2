import type { Scheduler } from '../../../../ecs/Scheduler';
import { SkillPolicyScopeSystem } from './SkillPolicyScopeSystem';

export function registerSkillSystems(scheduler: Scheduler): void {
  scheduler.addMany([SkillPolicyScopeSystem]);
}
