import { defineClientStateContributor } from '../../clientSync/contributors';
import { projectRulesClientState, rulesClientStateProjectionReads } from './stateProjection';

export { projectRulesClientState };

export const rulesClientSyncContributor = defineClientStateContributor({
  key: 'rules',
  tables: ['ruleFiles'],
  reads: rulesClientStateProjectionReads,
  project: projectRulesClientState,
  worker: {
    modulePath: '../world/modules/rules/clientSync',
    projectExport: 'projectRulesClientState'
  }
});
