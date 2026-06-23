import { defineClientStateContributor } from '../../clientSync/contributors';
import { projectRuntimeContextState, runtimeContextStateProjectionReads } from './stateProjection';

export const projectRuntimeContextClientState = projectRuntimeContextState;

export const runtimeContextClientSyncContributor = defineClientStateContributor({
  key: 'runtimeContext',
  tables: [
    'promptPlaceholders',
    'runtimeContexts',
    'runtimeContextScopeLinks',
    'runtimeContextSnapshots',
    'conversationRuntimeContextSnapshotLinks',
    'runRuntimeContextSnapshotLinks'
  ],
  reads: runtimeContextStateProjectionReads,
  project: projectRuntimeContextClientState,
  worker: {
    modulePath: '../world/modules/runtimeContext/clientSync',
    projectExport: 'projectRuntimeContextClientState'
  }
});
