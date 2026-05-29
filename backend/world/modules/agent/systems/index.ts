import type { Scheduler } from '../../../../ecs/Scheduler';
import { AgentSpawnSystem } from './AgentSpawnSystem';

export function registerAgentSystems(scheduler: Scheduler): void {
  scheduler.add(AgentSpawnSystem);
}
