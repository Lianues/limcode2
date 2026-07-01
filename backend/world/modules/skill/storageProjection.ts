import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { projectSkillRuntimeState, skillRuntimeStateProjectionReads } from './stateProjection';

export const skillStorageStateContributor = defineStorageStateContributor({
  key: 'skills',
  reads: skillRuntimeStateProjectionReads,
  project: projectSkillRuntimeState
});
