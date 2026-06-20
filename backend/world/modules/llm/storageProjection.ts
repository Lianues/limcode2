import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { llmStateProjectionReads, projectLlmState } from './stateProjection';

export const llmStorageStateContributor = defineStorageStateContributor({
  key: 'llm',
  reads: llmStateProjectionReads,
  project: projectLlmState
});
