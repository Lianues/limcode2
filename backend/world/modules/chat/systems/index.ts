import type { Scheduler } from '../../../../ecs/Scheduler';
import { ContextAssemblySystem } from './ContextAssemblySystem';
import { InputSystem } from './InputSystem';
import { LlmDispatchSystem } from './LlmDispatchSystem';
import { LlmPollSystem } from './LlmPollSystem';
import { MessageEditSystem } from './MessageEditSystem';

export function registerChatSystems(scheduler: Scheduler): void {
  scheduler.addMany([InputSystem, MessageEditSystem, ContextAssemblySystem, LlmDispatchSystem, LlmPollSystem]);
}
