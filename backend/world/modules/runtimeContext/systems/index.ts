import type { Scheduler } from '../../../../ecs/Scheduler';
import { RuntimeContextScopeSystem } from './RuntimeContextScopeSystem';
import { RuntimeContextSnapshotSystem } from './RuntimeContextSnapshotSystem';

export function registerRuntimeContextSystems(scheduler: Scheduler): void {
  scheduler.addMany([RuntimeContextScopeSystem, RuntimeContextSnapshotSystem]);
}

export { RuntimeContextScopeSystem, RuntimeContextSnapshotSystem };
