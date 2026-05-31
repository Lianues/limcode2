import type { Scheduler } from '../../../../ecs/Scheduler';
import { AgentRunDeliverySystem } from './AgentRunDeliverySystem';
import { AgentRunQueueSystem } from './AgentRunQueueSystem';

export function registerAgentRunSystems(scheduler: Scheduler): void {
  scheduler.addMany([AgentRunQueueSystem, AgentRunDeliverySystem]);
}
