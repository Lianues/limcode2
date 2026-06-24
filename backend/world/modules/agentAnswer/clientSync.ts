import { defineClientStateContributor } from '../../clientSync/contributors';
import { agentAnswerStateProjectionReads, projectAgentAnswerState } from './stateProjection';

export const projectAgentAnswerClientState = projectAgentAnswerState;

export const agentAnswerClientSyncContributor = defineClientStateContributor({
  key: 'agentAnswers',
  tables: ['agentAnswers', 'agentAnswerSubmissionLinks', 'agentAnswerTargetLinks'],
  reads: agentAnswerStateProjectionReads,
  project: projectAgentAnswerClientState,
  worker: {
    modulePath: '../world/modules/agentAnswer/clientSync',
    projectExport: 'projectAgentAnswerClientState'
  }
});
