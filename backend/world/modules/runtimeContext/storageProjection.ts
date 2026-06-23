import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { projectRuntimeContextState, runtimeContextStateProjectionReads } from './stateProjection';

export const runtimeContextStorageStateContributor = defineStorageStateContributor({
  key: 'runtimeContext',
  reads: runtimeContextStateProjectionReads,
  project(world) {
    const state = projectRuntimeContextState(world);
    return {
      runtimeContexts: state.runtimeContexts,
      runtimeContextScopeLinks: state.runtimeContextScopeLinks,
      runtimeContextSnapshots: state.runtimeContextSnapshots,
      conversationRuntimeContextSnapshotLinks: state.conversationRuntimeContextSnapshotLinks,
      runRuntimeContextSnapshotLinks: state.runRuntimeContextSnapshotLinks
    };
  }
});
