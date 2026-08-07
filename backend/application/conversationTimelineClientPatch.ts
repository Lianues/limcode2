import type { ClientPatchOp, ClientState, ClientStateTableKey } from '../../shared/protocol';
import { diffClientStateTables, diffUpsertRemove } from '../world/clientSync/diff';

const PERSISTED_TIMELINE_GENERIC_PATCH_TABLE_KEYS = [
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'toolCalls',
  'toolCallEvents',
  'projectContexts',
  'shadowRepositories',
  'conversationCheckpointRepositoryLinks',
  'checkpoints',
  'checkpointTimelineAnchors',
  'compressionBlocks',
  'compressionBlockSourceLinks',
  'compressionContextVariants',
  'compressionBlockLlmInvocationLinks',
  'llmInvocations'
] as const satisfies readonly ClientStateTableKey[];

/**
 * 把本宿主已确认的 conversation timeline base/next 转成 Webview 可机械应用的 patch。
 *
 * 只在 storage 成功提交后调用，因此 remove 表示领域删除，而不是 recent stream 窗口淘汰。
 */
export function createPersistedConversationTimelineClientPatches(
  previous: ClientState,
  next: ClientState
): ClientPatchOp[] {
  return [
    ...diffUpsertRemove(
      previous.messages,
      next.messages,
      (message): ClientPatchOp => ({ kind: 'message.upsert', message }),
      (id): ClientPatchOp => ({ kind: 'message.remove', id })
    ),
    ...diffClientStateTables(previous, next, PERSISTED_TIMELINE_GENERIC_PATCH_TABLE_KEYS)
  ];
}
