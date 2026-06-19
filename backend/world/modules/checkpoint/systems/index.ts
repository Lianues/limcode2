import type { Scheduler } from '../../../../ecs/Scheduler';
import { CheckpointDismissSystem } from './CheckpointDismissSystem';
import { CheckpointPolicyScopeSystem } from './CheckpointPolicyScopeSystem';
import { CheckpointRequestSystem } from './CheckpointRequestSystem';
import { CheckpointResultSystem } from './CheckpointResultSystem';

export function registerCheckpointSystems(scheduler: Scheduler): void {
  scheduler.addMany([CheckpointPolicyScopeSystem, CheckpointRequestSystem, CheckpointResultSystem, CheckpointDismissSystem]);
}

export { CheckpointDismissSystem, CheckpointPolicyScopeSystem, CheckpointRequestSystem, CheckpointResultSystem };
