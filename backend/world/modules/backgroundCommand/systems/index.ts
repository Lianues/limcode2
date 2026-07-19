import type { Scheduler } from '../../../../ecs/Scheduler';
import { BackgroundCommandNotificationSystem } from './BackgroundCommandNotificationSystem';

export function registerBackgroundCommandSystems(scheduler: Scheduler): void {
  scheduler.addMany([BackgroundCommandNotificationSystem]);
}
