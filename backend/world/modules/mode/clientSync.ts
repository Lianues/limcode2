import type {
  ClientPatchOp,
  ClientState
} from '../../../../shared/protocol';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor } from '../../clientSync/contributors';
import { modeStateProjectionReads, projectModeState } from './stateProjection';

export const projectModeClientState = projectModeState;

export function diffModeClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  return [
    ...diffUpsertRemove(prev.agentModes, next.agentModes, (agentMode): ClientPatchOp => ({ kind: 'agentMode.upsert', agentMode }), (id): ClientPatchOp => ({ kind: 'agentMode.remove', id })),
    ...diffUpsertRemove(prev.toolPolicies, next.toolPolicies, (toolPolicy): ClientPatchOp => ({ kind: 'toolPolicy.upsert', toolPolicy }), (id): ClientPatchOp => ({ kind: 'toolPolicy.remove', id })),
    ...diffUpsertRemove(prev.approvalPolicies, next.approvalPolicies, (approvalPolicy): ClientPatchOp => ({ kind: 'approvalPolicy.upsert', approvalPolicy }), (id): ClientPatchOp => ({ kind: 'approvalPolicy.remove', id })),
    ...diffUpsertRemove(prev.systemPrompts, next.systemPrompts, (systemPrompt): ClientPatchOp => ({ kind: 'systemPrompt.upsert', systemPrompt }), (id): ClientPatchOp => ({ kind: 'systemPrompt.remove', id })),
    ...diffUpsertRemove(prev.modelProfiles, next.modelProfiles, (modelProfile): ClientPatchOp => ({ kind: 'modelProfile.upsert', modelProfile }), (id): ClientPatchOp => ({ kind: 'modelProfile.remove', id })),
    ...diffUpsertRemove(prev.agentModeLinks, next.agentModeLinks, (link): ClientPatchOp => ({ kind: 'agentModeLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'agentModeLink.remove', id })),
    ...diffUpsertRemove(prev.modeToolPolicyLinks, next.modeToolPolicyLinks, (link): ClientPatchOp => ({ kind: 'modeToolPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'modeToolPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.modeApprovalPolicyLinks, next.modeApprovalPolicyLinks, (link): ClientPatchOp => ({ kind: 'modeApprovalPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'modeApprovalPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.modeSystemPromptLinks, next.modeSystemPromptLinks, (link): ClientPatchOp => ({ kind: 'modeSystemPromptLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'modeSystemPromptLink.remove', id })),
    ...diffUpsertRemove(prev.modeModelProfileLinks, next.modeModelProfileLinks, (link): ClientPatchOp => ({ kind: 'modeModelProfileLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'modeModelProfileLink.remove', id }))
  ];
}

export const modeClientSyncContributor = defineClientStateContributor({
  key: 'modes',
  reads: modeStateProjectionReads,
  project: projectModeClientState,
  diff: diffModeClientState,
  worker: {
    modulePath: '../world/modules/mode/clientSync',
    projectExport: 'projectModeClientState',
    diffExport: 'diffModeClientState'
  }
});
