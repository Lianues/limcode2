import type { Scheduler } from '../../../../ecs/Scheduler';
import { AskUserSystem } from './AskUserSystem';
import { ToolDispatchSystem } from './ToolDispatchSystem';
import { ToolPollSystem } from './ToolPollSystem';
import { ToolPolicyScopeSystem } from './ToolPolicyScopeSystem';
import { ToolResultSystem } from './ToolResultSystem';

export function registerToolSystems(scheduler: Scheduler): void {
  scheduler.addMany([ToolPolicyScopeSystem, ToolDispatchSystem, AskUserSystem, ToolPollSystem, ToolResultSystem]);
}
