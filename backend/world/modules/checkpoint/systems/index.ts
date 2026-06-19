import type { Scheduler } from '../../../../ecs/Scheduler';
import { CheckpointPolicyScopeSystem } from './CheckpointPolicyScopeSystem';
import { CheckpointRequestSystem } from './CheckpointRequestSystem';
import { CheckpointResultSystem } from './CheckpointResultSystem';

export function registerCheckpointSystems(scheduler: Scheduler): void {
  scheduler.addMany([CheckpointPolicyScopeSystem, CheckpointRequestSystem, CheckpointResultSystem]);
}

export { CheckpointPolicyScopeSystem, CheckpointRequestSystem, CheckpointResultSystem };
