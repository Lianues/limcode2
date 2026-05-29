import type { Scheduler } from '../../../ecs/Scheduler';
import { ClientSyncSystem } from './ClientSyncSystem';

export function registerClientSyncSystems(scheduler: Scheduler): void {
  scheduler.add(ClientSyncSystem);
}
