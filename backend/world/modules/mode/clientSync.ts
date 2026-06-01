import { defineClientStateContributor } from '../../clientSync/contributors';
import { modeStateProjectionReads, projectModeState } from './stateProjection';

export const projectModeClientState = projectModeState;

export const modeClientSyncContributor = defineClientStateContributor({
  key: 'modes',
  tables: [
    'agentModes',
    'toolPolicies',
    'approvalPolicies',
    'systemPrompts',
    'modelProfiles',
    'agentModeLinks',
    'modeToolPolicyLinks',
    'modeApprovalPolicyLinks',
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
