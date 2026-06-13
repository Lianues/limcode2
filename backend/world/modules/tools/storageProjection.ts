import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { projectToolsRuntimeState, toolsRuntimeStateProjectionReads } from './stateProjection';

export const toolsStorageStateContributor = defineStorageStateContributor({
  key: 'tools',
  reads: toolsRuntimeStateProjectionReads,
  project: projectToolsRuntimeState
});
