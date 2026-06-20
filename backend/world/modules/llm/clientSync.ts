import { defineClientStateContributor } from '../../clientSync/contributors';
import { llmStateProjectionReads, projectLlmState } from './stateProjection';

export const projectLlmClientState = projectLlmState;

export const llmClientSyncContributor = defineClientStateContributor({
  key: 'llm',
  tables: ['llmInvocations', 'runLlmInvocationLinks', 'messageLlmInvocationLinks'],
  reads: llmStateProjectionReads,
  project: projectLlmClientState,
  worker: {
    modulePath: '../world/modules/llm/clientSync',
    projectExport: 'projectLlmClientState'
  }
});
