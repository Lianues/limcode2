import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { agentStateProjectionReads, projectAgentState } from './stateProjection';

export const agentStorageStateContributor = defineStorageStateContributor({
  key: 'agents',
  reads: agentStateProjectionReads,
  project: projectAgentState
});
