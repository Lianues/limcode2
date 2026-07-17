import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { workflowStateProjectionReads, projectWorkflowState } from './stateProjection';

export const workflowStorageStateContributor = defineStorageStateContributor({
  key: 'workflows',
  reads: workflowStateProjectionReads,
  project: projectWorkflowState
});
