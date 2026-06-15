import { defineClientStateContributor } from '../../clientSync/contributors';
import { modeStateProjectionReads, projectModeState } from './stateProjection';

export const projectModeClientState = projectModeState;

export const modeClientSyncContributor = defineClientStateContributor({
  key: 'modes',
  tables: [
    'modes',
    'toolPolicies',
    'systemPrompts',
    'modelProfiles',
    'agentModeLinks',
    'conversationModeSelections',
    'modeToolPolicyLinks',
    'modeSystemPromptLinks',
    'modeModelProfileLinks'
  ],
  reads: modeStateProjectionReads,
  project: projectModeClientState,
  worker: {
    modulePath: '../world/modules/mode/clientSync',
    projectExport: 'projectModeClientState'
  }
});
