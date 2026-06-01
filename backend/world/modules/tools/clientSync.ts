import { defineClientStateContributor } from '../../clientSync/contributors';
import { projectToolsState, toolsStateProjectionReads } from './stateProjection';

export const projectToolsClientState = projectToolsState;

export const toolsClientSyncContributor = defineClientStateContributor({
  key: 'tools',
  tables: ['toolCalls', 'toolCallEvents'],
  reads: toolsStateProjectionReads,
  project: projectToolsClientState,
  worker: {
    modulePath: '../world/modules/tools/clientSync',
    projectExport: 'projectToolsClientState'
  }
});
