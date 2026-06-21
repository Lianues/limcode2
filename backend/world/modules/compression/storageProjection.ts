import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { compressionStateProjectionReads, projectCompressionState } from './stateProjection';

export const compressionStorageStateContributor = defineStorageStateContributor({
  key: 'compression',
  reads: compressionStateProjectionReads,
  project: projectCompressionState
});
