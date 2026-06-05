import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { projectStateProjectionReads, projectStateProjection } from './stateProjection';

export const projectStorageStateContributor = defineStorageStateContributor({
  key: 'project',
  reads: projectStateProjectionReads,
  project: projectStateProjection
});
