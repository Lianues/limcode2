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

export function markClientStateConversationDirty(world: WorldReader, cmd: CommandSink, conversationId: string | undefined): void {
  const id = conversationId?.trim();
  if (!id) return;
  const current = world.tryGetResource(ClientStateDirtyConversationIdsKey) ?? emptyDirtyConversationState();
  const ids = new Set(current.ids);
  ids.add(id);
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
  const resourceVersion = world.resourceVersion(ClientStateDirtyConversationIdsKey);
  if (resourceVersion <= lastSeenResourceVersion) return undefined;
  const state = world.tryGetResource(ClientStateDirtyConversationIdsKey);
  if (!state || state.ids.length === 0) return undefined;
  if (!canUseDirtyConversationHints(changedTableKeys)) return undefined;
  return { ids: new Set(state.ids), resourceVersion };
}

export function emptyDirtyConversationState(): ClientStateDirtyConversationIdsState {
  return { revision: 0, ids: [] };
}

function canUseDirtyConversationHints(tableKeys: readonly ClientStateTableKey[] | undefined): boolean {
  if (!tableKeys || tableKeys.length === 0) return false;
  return tableKeys.every((tableKey) => DIRTY_HINT_COMPATIBLE_TABLE_KEYS.has(tableKey));
}
