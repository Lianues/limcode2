import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { workEnvironmentStateProjection, workEnvironmentStateProjectionReads } from './stateProjection';

export const workEnvironmentStorageStateContributor = defineStorageStateContributor({
  key: 'workEnvironment',
  reads: workEnvironmentStateProjectionReads,
  project: workEnvironmentStateProjection
});
