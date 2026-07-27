import { defineClientStateContributor } from '../../clientSync/contributors';
import { agentRunClientStateProjectionReads, projectAgentRunClientState } from './stateProjection';

export { projectAgentRunClientState } from './stateProjection';

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
    'runWorkflowLinks',
    'runSystemPromptLinks',
    'runModelProfileLinks',
    'runToolPolicyLinks',
    'runConversationPolicyLinks',
    'runContextPolicyLinks',
    'runDeliveryPolicyLinks',
    'runEditPolicyLinks'
  ],
  reads: agentRunClientStateProjectionReads,
  project: projectAgentRunClientState,
  worker: {
    modulePath: '../world/modules/agentRun/clientSync',
    projectExport: 'projectAgentRunClientState'
  }
});
