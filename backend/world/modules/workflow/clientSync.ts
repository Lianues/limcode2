import { defineClientStateContributor } from '../../clientSync/contributors';
import { workflowStateProjectionReads, projectWorkflowState } from './stateProjection';

export const projectWorkflowClientState = projectWorkflowState;

export const workflowClientSyncContributor = defineClientStateContributor({
  key: 'workflows',
  tables: [
    'workflows',
    'toolPolicies',
    'systemPrompts',
    'systemPromptScopeLinks',
    'modelProfiles',
    'modelProfileScopeLinks',
    'conversationWorkflowSelections'
  ],
  reads: workflowStateProjectionReads,
  project: projectWorkflowClientState,
  worker: {
    modulePath: '../world/modules/workflow/clientSync',
    projectExport: 'projectWorkflowClientState'
  }
});
