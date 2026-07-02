import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { AgentRun } from '../../agentRun/components';
import { Conversation, Message } from '../../chat/components';
import { ProjectContext } from '../../project/components';
import { ToolCall } from '../../tools/components';
import { Checkpoint, CheckpointBarrier, CheckpointTimelineAnchor, ShadowRepository, type CheckpointBarrierReleaseReason } from '../components';
import { CheckpointEventType } from '../events';
import { CheckpointBundle } from '../bundles';
import { releaseCheckpointBarriers } from '../barriers';

export const CheckpointResultSystem = defineSystem({
  name: 'CheckpointResultSystem',
  shouldRun(ctx) {
    return readEvents(ctx, CheckpointEventType.Completed).length > 0;
  },
  access: {
    reads: { components: [AgentRun, Conversation, Message, ProjectContext, ShadowRepository, ToolCall, Checkpoint, CheckpointBarrier, CheckpointTimelineAnchor] },
    bundles: [CheckpointBundle],
    events: { read: [CheckpointEventType.Completed] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, CheckpointEventType.Completed)) {
      const conversation = findByRecordId(world, Conversation, payload.conversationId);
      const projectContext = findByRecordId(world, ProjectContext, payload.projectContextId);
      const shadowRepository = findByRecordId(world, ShadowRepository, payload.shadowRepositoryId);
      if (conversation === undefined || projectContext === undefined || shadowRepository === undefined) continue;

      const existing = findByRecordId(world, Checkpoint, payload.checkpointId);
      const entity = existing ?? cmd.spawn();
      cmd.add(entity, Checkpoint, {
        id: payload.checkpointId,
        conversation,
        projectContext,
        shadowRepository,
        trigger: payload.trigger,
        status: payload.status,
        projectUri: payload.projectUri,
        projectDisplayPath: payload.projectDisplayPath,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        ...(payload.commitSha ? { commitSha: payload.commitSha } : {}),
        ...(payload.skipReason ? { skipReason: payload.skipReason } : {}),
        ...(payload.message ? { message: payload.message } : {}),
        ...(payload.fileCount !== undefined ? { fileCount: payload.fileCount } : {}),
        ...(payload.byteCount !== undefined ? { byteCount: payload.byteCount } : {}),
        ...(payload.emptyDirectoryCount !== undefined ? { emptyDirectoryCount: payload.emptyDirectoryCount } : {})
      });

      if (payload.floorMessageId) {
        const floorMessage = findByRecordId(world, Message, payload.floorMessageId);
        if (floorMessage !== undefined) {
          const anchor = findByRecordId(world, CheckpointTimelineAnchor, checkpointTimelineAnchorId(payload.checkpointId));
          const anchorEntity = anchor ?? cmd.spawn();
          cmd.add(anchorEntity, CheckpointTimelineAnchor, {
            id: checkpointTimelineAnchorId(payload.checkpointId),
            conversation,
            checkpoint: entity,
            floorMessage,
            position: payload.anchorPosition ?? 'after',
            order: payload.createdAt,
            ...(payload.sourceRunId ? { sourceRunId: payload.sourceRunId } : {}),
            ...(payload.sourceToolCallId ? { sourceToolCallId: payload.sourceToolCallId } : {}),
            ...(payload.sourceRunId ? entityByRecordId(world, AgentRun, payload.sourceRunId, 'sourceRun') : {}),
            ...(payload.sourceToolCallId ? entityByRecordId(world, ToolCall, payload.sourceToolCallId, 'sourceToolCall') : {}),
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt
          });
        }
      }
      releaseCheckpointBarriers(world, cmd, payload.checkpointId, releaseReasonForStatus(payload.status));
    }
  }
});

function releaseReasonForStatus(status: string): CheckpointBarrierReleaseReason {
  if (status === 'created') return 'checkpoint_completed';
  if (status === 'skipped') return 'checkpoint_skipped';
  return 'checkpoint_failed';
}

function checkpointTimelineAnchorId(checkpointId: string): string {
  return `checkpoint-timeline-anchor:${checkpointId}`;
}

function entityByRecordId<TKey extends string>(
  world: WorldReader,
  component: { id: symbol },
  id: string,
  key: TKey
): Record<TKey, Entity> | Record<string, never> {
  const entity = findByRecordId(world, component, id);
  return entity === undefined ? {} : { [key]: entity } as Record<TKey, Entity>;
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: { id: symbol }, id: string): Entity | undefined {
  return world.query(component as never).find((entity) => (world.get(entity, component as never) as T | undefined)?.id === id);
}
