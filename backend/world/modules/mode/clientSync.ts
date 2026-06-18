import { defineClientStateContributor } from '../../clientSync/contributors';
import { modeStateProjectionReads, projectModeState } from './stateProjection';

export const projectModeClientState = projectModeState;

export const modeClientSyncContributor = defineClientStateContributor({
  key: 'modes',
  tables: [
    'modes',
    'toolPolicies',
    'systemPrompts',
    'systemPromptScopeLinks',
    'modelProfiles',
    'modelProfileScopeLinks',
    'conversationModeSelections'
  ],
  reads: modeStateProjectionReads,
  project: projectModeClientState,
  worker: {
    modulePath: '../world/modules/mode/clientSync',
    projectExport: 'projectModeClientState'
  }
});
