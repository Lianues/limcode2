import type { CommandSink, WorldReader } from '../../ecs/types';
import type { ClientStateTableKey } from '../../../shared/protocol';
import { ClientStateDirtyConversationIdsKey, type ClientStateDirtyConversationIdsState } from './resources';

const DIRTY_HINT_COMPATIBLE_TABLE_KEYS = new Set<ClientStateTableKey>([
  'conversations',
  'conversationReuseLinks',
  'conversationBranchLinks',
  'conversationOriginLinks',
  'conversationProjectLinks',
  'conversationModeSelections',
  'conversationWorkEnvironmentLinks',
  'conversationRuntimeContextSnapshotLinks',
  'conversationCheckpointRepositoryLinks',
  'checkpointTimelineAnchors',
  'checkpoints',
  'projectContexts',
  'shadowRepositories',
  'messages',
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'toolCalls',
  'toolCallEvents',
  'agentRuns',
  'agentRunSourceLinks',
  'agentRunTargetLinks',
  'agentRunQueueOrders',
  'agentRunQueueHolds',
  'agentRunQueuedInputs',
  'messageRunLinks',
  'toolCallRunLinks',
  'runConversationPolicies',
  'runContextPolicies',
  'runDeliveryPolicies',
  'runEditPolicies',
  'runModeLinks',
  'runSystemPromptLinks',
  'runModelProfileLinks',
  'runToolPolicyLinks',
  'runConversationPolicyLinks',
  'runContextPolicyLinks',
  'runDeliveryPolicyLinks',
  'runEditPolicyLinks',
  'agentRunInputRevisions',
  'llmInvocations',
  'runLlmInvocationLinks',
  'messageLlmInvocationLinks',
  'runtimeContextSnapshots',
  'runRuntimeContextSnapshotLinks',
  'runWorkEnvironmentLinks',
  'compressionBlocks',
  'compressionBlockSourceLinks',
  'compressionContextVariants',
  'runCompressionBlockLinks',
  'compressionBlockLlmInvocationLinks'
]);

const DIRTY_HINT_IGNORED_GLOBAL_TABLE_KEYS = new Set<ClientStateTableKey>([
  'agents',
  'agentConversationLinks',
  'conversationAgentSelections',
  'modes',
  'toolPolicies',
  'systemPrompts',
  'systemPromptScopeLinks',
  'modelProfiles',
  'modelProfileScopeLinks',
  'toolDefinitions',
  'mcpToolSources',
  'toolPolicyScopeLinks',
  'checkpointPolicies',
  'checkpointPolicyScopeLinks',
  'promptPlaceholders',
  'runtimeContexts',
  'runtimeContextScopeLinks',
  'skillDefinitions',
  'skillPolicies',
  'skillPolicyScopeLinks',
  'ruleFiles',
  'workEnvironments',
  'workEnvironmentPolicies',
  'workEnvironmentPolicyScopeLinks',
  'agentAnswers',
  'agentAnswerSubmissionLinks',
  'agentAnswerTargetLinks'
]);

export function markClientStateConversationDirty(world: WorldReader, cmd: CommandSink, conversationId: string | undefined): void {
  markClientStateConversationsDirty(world, cmd, [conversationId]);
}

export function markClientStateConversationsDirty(
  world: WorldReader,
  cmd: CommandSink,
  conversationIds: Iterable<string | undefined>
): void {
  const current = world.tryGetResource(ClientStateDirtyConversationIdsKey) ?? emptyDirtyConversationState();
  const ids = new Set(current.ids);
  let hasConversationId = false;
  for (const conversationId of conversationIds) {
    const id = conversationId?.trim();
    if (!id) continue;
    hasConversationId = true;
    ids.add(id);
  }
  if (!hasConversationId) return;
  cmd.setResource(ClientStateDirtyConversationIdsKey, {
    revision: current.revision + 1,
    ids: [...ids]
  });
}

export function dirtyConversationIdsSince(
  world: WorldReader,
  lastSeenResourceVersion: number,
  changedTableKeys: readonly ClientStateTableKey[] | undefined
): { ids: ReadonlySet<string>; resourceVersion: number } | undefined {
  void lastSeenResourceVersion;
  const tableScope = dirtyHintTableScope(changedTableKeys);
  if (!tableScope.canUse) return undefined;
  const resourceVersion = world.resourceVersion(ClientStateDirtyConversationIdsKey);
  const state = world.tryGetResource(ClientStateDirtyConversationIdsKey);
  if (!tableScope.hasConversationScopedChange) return { ids: new Set(), resourceVersion };
  if (!state || state.ids.length === 0) return undefined;
  return { ids: new Set(state.ids), resourceVersion };
}

export function emptyDirtyConversationState(): ClientStateDirtyConversationIdsState {
  return { revision: 0, ids: [] };
}

function dirtyHintTableScope(tableKeys: readonly ClientStateTableKey[] | undefined): { canUse: boolean; hasConversationScopedChange: boolean } {
  if (!tableKeys || tableKeys.length === 0) return { canUse: false, hasConversationScopedChange: false };
  let hasConversationScopedChange = false;
  for (const tableKey of tableKeys) {
    if (DIRTY_HINT_COMPATIBLE_TABLE_KEYS.has(tableKey)) {
      hasConversationScopedChange = true;
      continue;
    }
    if (DIRTY_HINT_IGNORED_GLOBAL_TABLE_KEYS.has(tableKey)) continue;
    return { canUse: false, hasConversationScopedChange: false };
  }
  return { canUse: true, hasConversationScopedChange };
}
