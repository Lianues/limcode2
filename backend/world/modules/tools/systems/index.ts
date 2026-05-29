import type { Scheduler } from '../../../../ecs/Scheduler';
import { ToolDispatchSystem } from './ToolDispatchSystem';
import { ToolPollSystem } from './ToolPollSystem';
import { ToolResultSystem } from './ToolResultSystem';

export function registerToolSystems(scheduler: Scheduler): void {
  scheduler.addMany([ToolDispatchSystem, ToolPollSystem, ToolResultSystem]);
}
