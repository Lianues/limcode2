import { defineClientStateContributor } from '../../clientSync/contributors';
import { agentRunStateProjectionReads, projectAgentRunState } from './stateProjection';

export const projectAgentRunClientState = projectAgentRunState;

export const agentRunClientSyncContributor = defineClientStateContributor({
  key: 'agentRuns',
  tables: [
    'agentRuns',
    'agentRunSourceLinks',
    'agentRunTargetLinks',
    'agentRunQueueOrders',
    'agentRunQueueHolds',
    'agentRunQueuedInputs',
    'messageRunLinks',
    'toolCallRunLinks',
    'runConversationPolicies',
    'runContextPolicies',
    'runDeliveryPolicies',
    'runEditPolicies',
    'runModeLinks',
    'runSystemPromptLinks',
    'runModelProfileLinks',
    'runToolPolicyLinks',
    'runConversationPolicyLinks',
    'runContextPolicyLinks',
    'runDeliveryPolicyLinks',
    'runEditPolicyLinks',
    'agentRunInputRevisions'
  ],
  reads: agentRunStateProjectionReads,
  project: projectAgentRunClientState,
  worker: {
    modulePath: '../world/modules/agentRun/clientSync',
    projectExport: 'projectAgentRunClientState'
  }
});
