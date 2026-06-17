import type { Scheduler } from '../../../../ecs/Scheduler';
import { ConversationWorkEnvironmentDefaultSystem } from './ConversationWorkEnvironmentDefaultSystem';
import { ConversationWorkEnvironmentSelectionSystem } from './ConversationWorkEnvironmentSelectionSystem';
import { RunWorkEnvironmentSnapshotSystem } from './RunWorkEnvironmentSnapshotSystem';
import { WorkEnvironmentMutationSystem } from './WorkEnvironmentMutationSystem';
import { WorkEnvironmentPolicyDefaultSystem } from './WorkEnvironmentPolicyDefaultSystem';
import { WorkEnvironmentPolicyScopeSystem } from './WorkEnvironmentPolicyScopeSystem';
import { WorkEnvironmentSyncSystem } from './WorkEnvironmentSyncSystem';

export function registerWorkEnvironmentSystems(scheduler: Scheduler): void {
  scheduler.addMany([
    WorkEnvironmentSyncSystem,
    WorkEnvironmentMutationSystem,
    WorkEnvironmentPolicyScopeSystem,
    WorkEnvironmentPolicyDefaultSystem,
    ConversationWorkEnvironmentSelectionSystem,
    ConversationWorkEnvironmentDefaultSystem,
    RunWorkEnvironmentSnapshotSystem
  ]);
}

export {
  ConversationWorkEnvironmentDefaultSystem,
  ConversationWorkEnvironmentSelectionSystem,
  RunWorkEnvironmentSnapshotSystem,
  WorkEnvironmentMutationSystem,
  WorkEnvironmentPolicyDefaultSystem,
  WorkEnvironmentPolicyScopeSystem,
  WorkEnvironmentSyncSystem
};
