import { defineClientStateContributor } from '../../clientSync/contributors';
import { agentStateProjectionReads, projectAgentState } from './stateProjection';

export const projectAgentClientState = projectAgentState;

export const agentClientSyncContributor = defineClientStateContributor({
  key: 'agents',
  tables: ['agents', 'agentConversationLinks'],
  reads: agentStateProjectionReads,
  project: projectAgentClientState,
  worker: {
    modulePath: '../world/modules/agent/clientSync',
    projectExport: 'projectAgentClientState'
  }
});
