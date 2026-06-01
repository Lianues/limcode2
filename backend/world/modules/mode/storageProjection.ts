import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { modeStateProjectionReads, projectModeState } from './stateProjection';

export const modeStorageStateContributor = defineStorageStateContributor({
  key: 'modes',
  reads: modeStateProjectionReads,
  project: projectModeState
});
