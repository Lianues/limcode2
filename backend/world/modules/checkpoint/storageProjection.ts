import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { checkpointStateProjection, checkpointStateProjectionReads } from './stateProjection';

export const checkpointStorageStateContributor = defineStorageStateContributor({
  key: 'checkpoint',
  reads: checkpointStateProjectionReads,
  project: checkpointStateProjection
});
