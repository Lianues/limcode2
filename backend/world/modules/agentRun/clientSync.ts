import type { ClientPatchOp, ClientState } from '../../../../shared/protocol';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor } from '../../clientSync/contributors';
import { agentRunStateProjectionReads, projectAgentRunState } from './stateProjection';

export const projectAgentRunClientState = projectAgentRunState;

export function diffAgentRunClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  return [
    ...diffUpsertRemove(prev.agentRuns, next.agentRuns, (run): ClientPatchOp => ({ kind: 'agentRun.upsert', run }), (id): ClientPatchOp => ({ kind: 'agentRun.remove', id })),
    ...diffUpsertRemove(prev.agentRunSourceLinks, next.agentRunSourceLinks, (link): ClientPatchOp => ({ kind: 'agentRunSourceLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'agentRunSourceLink.remove', id })),
    ...diffUpsertRemove(prev.agentRunTargetLinks, next.agentRunTargetLinks, (link): ClientPatchOp => ({ kind: 'agentRunTargetLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'agentRunTargetLink.remove', id })),
    ...diffUpsertRemove(prev.messageRunLinks, next.messageRunLinks, (link): ClientPatchOp => ({ kind: 'messageRunLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'messageRunLink.remove', id })),
    ...diffUpsertRemove(prev.toolCallRunLinks, next.toolCallRunLinks, (link): ClientPatchOp => ({ kind: 'toolCallRunLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'toolCallRunLink.remove', id })),
    ...diffUpsertRemove(prev.runConversationPolicies, next.runConversationPolicies, (policy): ClientPatchOp => ({ kind: 'runConversationPolicy.upsert', policy }), (id): ClientPatchOp => ({ kind: 'runConversationPolicy.remove', id })),
    ...diffUpsertRemove(prev.runContextPolicies, next.runContextPolicies, (policy): ClientPatchOp => ({ kind: 'runContextPolicy.upsert', policy }), (id): ClientPatchOp => ({ kind: 'runContextPolicy.remove', id })),
    ...diffUpsertRemove(prev.runDeliveryPolicies, next.runDeliveryPolicies, (policy): ClientPatchOp => ({ kind: 'runDeliveryPolicy.upsert', policy }), (id): ClientPatchOp => ({ kind: 'runDeliveryPolicy.remove', id })),
    ...diffUpsertRemove(prev.runEditPolicies, next.runEditPolicies, (policy): ClientPatchOp => ({ kind: 'runEditPolicy.upsert', policy }), (id): ClientPatchOp => ({ kind: 'runEditPolicy.remove', id })),
    ...diffUpsertRemove(prev.runModeLinks, next.runModeLinks, (link): ClientPatchOp => ({ kind: 'runModeLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runModeLink.remove', id })),
    ...diffUpsertRemove(prev.runSystemPromptLinks, next.runSystemPromptLinks, (link): ClientPatchOp => ({ kind: 'runSystemPromptLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runSystemPromptLink.remove', id })),
    ...diffUpsertRemove(prev.runModelProfileLinks, next.runModelProfileLinks, (link): ClientPatchOp => ({ kind: 'runModelProfileLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runModelProfileLink.remove', id })),
    ...diffUpsertRemove(prev.runToolPolicyLinks, next.runToolPolicyLinks, (link): ClientPatchOp => ({ kind: 'runToolPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runToolPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.runApprovalPolicyLinks, next.runApprovalPolicyLinks, (link): ClientPatchOp => ({ kind: 'runApprovalPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runApprovalPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.runConversationPolicyLinks, next.runConversationPolicyLinks, (link): ClientPatchOp => ({ kind: 'runConversationPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runConversationPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.runContextPolicyLinks, next.runContextPolicyLinks, (link): ClientPatchOp => ({ kind: 'runContextPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runContextPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.runDeliveryPolicyLinks, next.runDeliveryPolicyLinks, (link): ClientPatchOp => ({ kind: 'runDeliveryPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runDeliveryPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.runEditPolicyLinks, next.runEditPolicyLinks, (link): ClientPatchOp => ({ kind: 'runEditPolicyLink.upsert', link }), (id): ClientPatchOp => ({ kind: 'runEditPolicyLink.remove', id })),
    ...diffUpsertRemove(prev.agentRunInputRevisions, next.agentRunInputRevisions, (inputRevision): ClientPatchOp => ({ kind: 'agentRunInputRevision.upsert', inputRevision }), (id): ClientPatchOp => ({ kind: 'agentRunInputRevision.remove', id }))
  ];
}

export const agentRunClientSyncContributor = defineClientStateContributor({
  key: 'agentRuns',
  reads: agentRunStateProjectionReads,
  project: projectAgentRunClientState,
  diff: diffAgentRunClientState,
  worker: {
    modulePath: '../world/modules/agentRun/clientSync',
    projectExport: 'projectAgentRunClientState',
    diffExport: 'diffAgentRunClientState'
  }
});
