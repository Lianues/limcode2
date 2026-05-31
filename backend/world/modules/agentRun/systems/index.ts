import type { Scheduler } from '../../../../ecs/Scheduler';
import { AgentRunDeliverySystem } from './AgentRunDeliverySystem';
import { AgentRunLifecycleSystem } from './AgentRunLifecycleSystem';
import { AgentRunQueueSystem } from './AgentRunQueueSystem';

export function registerAgentRunSystems(scheduler: Scheduler): void {
  scheduler.addMany([AgentRunLifecycleSystem, AgentRunQueueSystem, AgentRunDeliverySystem]);
}
