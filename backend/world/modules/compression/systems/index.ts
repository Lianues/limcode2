import type { Scheduler } from '../../../../ecs/Scheduler';
import { CompressionSystem } from './CompressionSystem';

export function registerCompressionSystems(scheduler: Scheduler): void {
  scheduler.add(CompressionSystem);
}
