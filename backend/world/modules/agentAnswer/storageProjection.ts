import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { agentAnswerStateProjectionReads, projectAgentAnswerState } from './stateProjection';

export const agentAnswerStorageStateContributor = defineStorageStateContributor({
  key: 'agentAnswers',
  reads: agentAnswerStateProjectionReads,
  project: projectAgentAnswerState
});
