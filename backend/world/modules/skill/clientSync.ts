import { defineClientStateContributor } from '../../clientSync/contributors';
import { projectSkillClientState, skillClientStateProjectionReads } from './stateProjection';

export { projectSkillClientState };

export const skillClientSyncContributor = defineClientStateContributor({
  key: 'skills',
  tables: ['skillDefinitions', 'skillPolicies', 'skillPolicyScopeLinks'],
  reads: skillClientStateProjectionReads,
  project: projectSkillClientState,
  worker: {
    modulePath: '../world/modules/skill/clientSync',
    projectExport: 'projectSkillClientState'
  }
});
