import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { projectToolsState, toolsStateProjectionReads } from './stateProjection';

export const toolsStorageStateContributor = defineStorageStateContributor({
  key: 'tools',
  reads: toolsStateProjectionReads,
  project: projectToolsState
});
