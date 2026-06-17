import { defineClientStateContributor } from '../../clientSync/contributors';
import { workEnvironmentStateProjection, workEnvironmentStateProjectionReads } from './stateProjection';

export const projectWorkEnvironmentClientState = workEnvironmentStateProjection;

export const workEnvironmentClientSyncContributor = defineClientStateContributor({
  key: 'workEnvironment',
  tables: ['workEnvironments', 'workEnvironmentPolicies', 'workEnvironmentPolicyScopeLinks', 'conversationWorkEnvironmentLinks', 'runWorkEnvironmentLinks'],
  reads: workEnvironmentStateProjectionReads,
  project: projectWorkEnvironmentClientState,
  worker: {
    modulePath: '../world/modules/workEnvironment/clientSync',
    projectExport: 'projectWorkEnvironmentClientState'
  }
});
