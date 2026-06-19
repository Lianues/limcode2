import { defineClientStateContributor } from '../../clientSync/contributors';
import { checkpointStateProjection, checkpointStateProjectionReads } from './stateProjection';

export const projectCheckpointClientState = checkpointStateProjection;

export const checkpointClientSyncContributor = defineClientStateContributor({
  key: 'checkpoint',
  tables: [
    'checkpointPolicies',
    'checkpointPolicyScopeLinks',
    'shadowRepositories',
    'conversationCheckpointRepositoryLinks',
    'checkpoints',
    'checkpointTimelineAnchors'
  ],
  reads: checkpointStateProjectionReads,
  project: projectCheckpointClientState,
  worker: {
    modulePath: '../world/modules/checkpoint/clientSync',
    projectExport: 'projectCheckpointClientState'
  }
});
