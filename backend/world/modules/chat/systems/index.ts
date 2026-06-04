import type { Scheduler } from '../../../../ecs/Scheduler';
import { ContextAssemblySystem } from './ContextAssemblySystem';
import { InputSystem } from './InputSystem';
import { LlmDispatchSystem } from './LlmDispatchSystem';
import { LlmPollSystem } from './LlmPollSystem';
import { MessageDeleteSystem } from './MessageDeleteSystem';
import { MessageEditSystem } from './MessageEditSystem';
import { MessageRetrySystem } from './MessageRetrySystem';

export function registerChatSystems(scheduler: Scheduler): void {
  scheduler.addMany([InputSystem, MessageEditSystem, MessageDeleteSystem, MessageRetrySystem, ContextAssemblySystem, LlmDispatchSystem, LlmPollSystem]);
}
