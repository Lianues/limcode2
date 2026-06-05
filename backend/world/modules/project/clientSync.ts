import { defineClientStateContributor } from '../../clientSync/contributors';
import { projectStateProjectionReads, projectStateProjection } from './stateProjection';

export const projectClientStateProjection = projectStateProjection;

export const projectClientSyncContributor = defineClientStateContributor({
  key: 'project',
  tables: ['projectContexts', 'conversationProjectLinks'],
  reads: projectStateProjectionReads,
  project: projectClientStateProjection,
  worker: {
    modulePath: '../world/modules/project/clientSync',
    projectExport: 'projectClientStateProjection'
  }
});
