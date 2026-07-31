import type { Scheduler } from '../../../../ecs/Scheduler';
import { AgentCrudSystem } from './AgentCrudSystem';
import { AgentSpawnSystem } from './AgentSpawnSystem';
import { ConversationAgentBindingSystem } from './ConversationAgentBindingSystem';

export function registerAgentSystems(scheduler: Scheduler): void {
  scheduler.add(AgentCrudSystem);
  scheduler.add(AgentSpawnSystem);
  scheduler.add(ConversationAgentBindingSystem);
}
