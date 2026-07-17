import type { Scheduler } from '../../../../ecs/Scheduler';
import { ConversationWorkflowSelectionSystem } from './ConversationWorkflowSelectionSystem';
import { WorkflowCrudSystem } from './WorkflowCrudSystem';

export function registerWorkflowSystems(scheduler: Scheduler): void {
  scheduler.add(WorkflowCrudSystem);
  scheduler.add(ConversationWorkflowSelectionSystem);
}

export { ConversationWorkflowSelectionSystem, WorkflowCrudSystem };
