import type { Scheduler } from '../../../../ecs/Scheduler';
import { AgentRunDeliverySystem } from './AgentRunDeliverySystem';

export function registerAgentRunSystems(scheduler: Scheduler): void {
  scheduler.addMany([AgentRunDeliverySystem]);
}
