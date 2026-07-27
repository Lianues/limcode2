import type { Scheduler } from '../../../../ecs/Scheduler';
import { ContextAssemblySystem } from './ContextAssemblySystem';
import { InputSystem } from './InputSystem';
import { LlmDispatchSystem } from './LlmDispatchSystem';
import { LlmPollSystem } from './LlmPollSystem';
import { MessageDeleteSystem } from './MessageDeleteSystem';
import { MessageEditSystem } from './MessageEditSystem';
import { MessageRetrySystem } from './MessageRetrySystem';

export function registerChatSystems(scheduler: Scheduler): void {
  // 同一会话的截断与随后发送可能在同一 scheduler tick 入队。
  // 先提交时间线变更，再处理新输入，避免新消息被旧的 delete/retry 后缀级联吞掉。
  scheduler.addMany([MessageEditSystem, MessageDeleteSystem, MessageRetrySystem, InputSystem, ContextAssemblySystem, LlmDispatchSystem, LlmPollSystem]);
}
