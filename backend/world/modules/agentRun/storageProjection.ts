import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { agentRunStateProjectionReads, projectAgentRunState } from './stateProjection';

export const agentRunStorageStateContributor = defineStorageStateContributor({
  key: 'agentRuns',
  reads: agentRunStateProjectionReads,
  project: projectAgentRunState
});
