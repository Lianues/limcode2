import type * as vscode from 'vscode';
import type { ClientState, ClientStateTableKey } from '../../../shared/protocol';
import type { createVscodeStoragePaths } from './paths';

export type ClientStateSkeletonProfile = 'startup' | 'deferred';
export const CLIENT_STATE_SKELETON_STORE_KEYS = [
  'agents', 'workflows', 'planReviewPolicies', 'planReviewPolicyScopeLinks',
  'toolPolicies', 'toolPolicyScopeLinks', 'skillPolicies', 'skillPolicyScopeLinks',
  'systemPrompts', 'systemPromptScopeLinks', 'runtimeContexts', 'runtimeContextScopeLinks',
  'runtimeContextSnapshots', 'conversationRuntimeContextSnapshotLinks', 'runRuntimeContextSnapshotLinks',
  'modelProfiles', 'modelProfileScopeLinks', 'conversationWorkflowSelections', 'conversations',
  'conversationReuseLinks', 'conversationBranchLinks', 'conversationOriginLinks',
  'agentConversationLinks', 'conversationAgentSelections', 'agentAnswers',
  'agentAnswerSubmissionLinks', 'agentAnswerTargetLinks', 'projectContexts',
  'conversationProjectLinks', 'workEnvironments', 'workEnvironmentPolicies',
  'workEnvironmentPolicyScopeLinks', 'conversationWorkEnvironmentLinks', 'runWorkEnvironmentLinks',
  'checkpointPolicies', 'checkpointPolicyScopeLinks', 'shadowRepositories',
  'conversationCheckpointRepositoryLinks', 'checkpoints', 'checkpointTimelineAnchors'
] as const satisfies readonly ClientStateTableKey[];
export type ClientStateSkeletonStoreKey = typeof CLIENT_STATE_SKELETON_STORE_KEYS[number];
export type ClientStateSkeletonRecord = { id: string };
export type ClientStateSkeletonPaths = ReturnType<typeof createVscodeStoragePaths>;

export interface ClientStateSkeletonStoreDescriptor {
  key: ClientStateSkeletonStoreKey;
  profile: ClientStateSkeletonProfile;
  root: (paths: ClientStateSkeletonPaths) => vscode.Uri;
  recordKey: string;
  label: (record: ClientStateSkeletonRecord) => string;
}

const idLabel = (record: ClientStateSkeletonRecord): string => record.id;
const fieldLabel = (field: string) => (record: ClientStateSkeletonRecord): string => {
  const value = (record as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() ? value : record.id;
};

/**
 * ClientState skeleton 的唯一 store registry。加载 profile、patch diff、generation prepare、
 * manifest exact-key 校验和 GC 都必须从这里派生，禁止再维护平行硬编码清单。
 */
export const CLIENT_STATE_SKELETON_STORES = [
  { key: 'agents', profile: 'startup', root: (paths) => paths.agentsRootUri, recordKey: 'agent', label: fieldLabel('name') },
  { key: 'workflows', profile: 'startup', root: (paths) => paths.workflowsRootUri, recordKey: 'workflow', label: fieldLabel('name') },
  { key: 'planReviewPolicies', profile: 'startup', root: (paths) => paths.planReviewPoliciesRootUri, recordKey: 'policy', label: idLabel },
  { key: 'planReviewPolicyScopeLinks', profile: 'startup', root: (paths) => paths.planReviewPolicyScopeLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'toolPolicies', profile: 'startup', root: (paths) => paths.toolPoliciesRootUri, recordKey: 'toolPolicy', label: fieldLabel('name') },
  { key: 'toolPolicyScopeLinks', profile: 'startup', root: (paths) => paths.toolPolicyScopeLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'skillPolicies', profile: 'startup', root: (paths) => paths.skillPoliciesRootUri, recordKey: 'skillPolicy', label: fieldLabel('name') },
  { key: 'skillPolicyScopeLinks', profile: 'startup', root: (paths) => paths.skillPolicyScopeLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'systemPrompts', profile: 'startup', root: (paths) => paths.systemPromptsRootUri, recordKey: 'systemPrompt', label: fieldLabel('name') },
  { key: 'systemPromptScopeLinks', profile: 'startup', root: (paths) => paths.systemPromptScopeLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'runtimeContexts', profile: 'startup', root: (paths) => paths.runtimeContextsRootUri, recordKey: 'runtimeContext', label: fieldLabel('name') },
  { key: 'runtimeContextScopeLinks', profile: 'startup', root: (paths) => paths.runtimeContextScopeLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'runtimeContextSnapshots', profile: 'startup', root: (paths) => paths.runtimeContextSnapshotsRootUri, recordKey: 'snapshot', label: fieldLabel('name') },
  { key: 'conversationRuntimeContextSnapshotLinks', profile: 'startup', root: (paths) => paths.conversationRuntimeContextSnapshotLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'runRuntimeContextSnapshotLinks', profile: 'startup', root: (paths) => paths.runRuntimeContextSnapshotLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'modelProfiles', profile: 'startup', root: (paths) => paths.modelProfilesRootUri, recordKey: 'modelProfile', label: fieldLabel('name') },
  { key: 'modelProfileScopeLinks', profile: 'startup', root: (paths) => paths.modelProfileScopeLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'conversationWorkflowSelections', profile: 'startup', root: (paths) => paths.conversationWorkflowSelectionsRootUri, recordKey: 'selection', label: idLabel },
  { key: 'conversations', profile: 'startup', root: (paths) => paths.conversationsRootUri, recordKey: 'conversation', label: fieldLabel('title') },
  { key: 'conversationReuseLinks', profile: 'startup', root: (paths) => paths.conversationReuseLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'conversationBranchLinks', profile: 'startup', root: (paths) => paths.conversationBranchLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'conversationOriginLinks', profile: 'startup', root: (paths) => paths.conversationOriginLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'agentConversationLinks', profile: 'startup', root: (paths) => paths.linksRootUri, recordKey: 'link', label: idLabel },
  { key: 'conversationAgentSelections', profile: 'startup', root: (paths) => paths.conversationAgentSelectionsRootUri, recordKey: 'selection', label: idLabel },
  { key: 'agentAnswers', profile: 'startup', root: (paths) => paths.agentAnswersRootUri, recordKey: 'answer', label: fieldLabel('title') },
  { key: 'agentAnswerSubmissionLinks', profile: 'startup', root: (paths) => paths.agentAnswerSubmissionLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'agentAnswerTargetLinks', profile: 'startup', root: (paths) => paths.agentAnswerTargetLinksRootUri, recordKey: 'link', label: idLabel },

  { key: 'projectContexts', profile: 'deferred', root: (paths) => paths.projectContextsRootUri, recordKey: 'projectContext', label: fieldLabel('name') },
  { key: 'conversationProjectLinks', profile: 'deferred', root: (paths) => paths.conversationProjectLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'workEnvironments', profile: 'deferred', root: (paths) => paths.workEnvironmentsRootUri, recordKey: 'workEnvironment', label: fieldLabel('name') },
  { key: 'workEnvironmentPolicies', profile: 'deferred', root: (paths) => paths.workEnvironmentPoliciesRootUri, recordKey: 'policy', label: fieldLabel('name') },
  { key: 'workEnvironmentPolicyScopeLinks', profile: 'deferred', root: (paths) => paths.workEnvironmentPolicyScopeLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'conversationWorkEnvironmentLinks', profile: 'deferred', root: (paths) => paths.conversationWorkEnvironmentLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'runWorkEnvironmentLinks', profile: 'deferred', root: (paths) => paths.runWorkEnvironmentLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'checkpointPolicies', profile: 'deferred', root: (paths) => paths.checkpointPoliciesRootUri, recordKey: 'policy', label: fieldLabel('name') },
  { key: 'checkpointPolicyScopeLinks', profile: 'deferred', root: (paths) => paths.checkpointPolicyScopeLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'shadowRepositories', profile: 'deferred', root: (paths) => paths.shadowRepositoriesRootUri, recordKey: 'shadowRepository', label: idLabel },
  { key: 'conversationCheckpointRepositoryLinks', profile: 'deferred', root: (paths) => paths.conversationCheckpointRepositoryLinksRootUri, recordKey: 'link', label: idLabel },
  { key: 'checkpoints', profile: 'deferred', root: (paths) => paths.checkpointsRootUri, recordKey: 'checkpoint', label: fieldLabel('projectDisplayPath') },
  { key: 'checkpointTimelineAnchors', profile: 'deferred', root: (paths) => paths.checkpointTimelineAnchorsRootUri, recordKey: 'anchor', label: idLabel }
] as const satisfies readonly ClientStateSkeletonStoreDescriptor[];


export function skeletonStoresForProfile(profile: 'startup' | 'deferred' | 'full'): readonly ClientStateSkeletonStoreDescriptor[] {
  return profile === 'full'
    ? CLIENT_STATE_SKELETON_STORES
    : CLIENT_STATE_SKELETON_STORES.filter((store) => store.profile === profile);
}

export function skeletonRecordsFromState(state: ClientState, key: ClientStateSkeletonStoreKey): ClientStateSkeletonRecord[] {
  return state[key] as ClientStateSkeletonRecord[];
}

export function assignSkeletonRecordsToState(
  state: ClientState,
  key: ClientStateSkeletonStoreKey,
  records: ClientStateSkeletonRecord[]
): void {
  (state as unknown as Record<ClientStateTableKey, ClientStateSkeletonRecord[]>)[key] = records;
}
