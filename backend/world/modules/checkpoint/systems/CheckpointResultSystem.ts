import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Conversation } from '../../chat/components';
import { ProjectContext } from '../../project/components';
import { Checkpoint, ShadowRepository } from '../components';
import { CheckpointEventType } from '../events';
import { CheckpointBundle } from '../bundles';

export const CheckpointResultSystem = defineSystem({
  name: 'CheckpointResultSystem',
  shouldRun(ctx) {
    return readEvents(ctx, CheckpointEventType.Completed).length > 0;
  },
  access: {
    reads: { components: [Conversation, ProjectContext, ShadowRepository, Checkpoint] },
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
    }
  }
});

function findByRecordId<T extends { id: string }>(world: WorldReader, component: { id: symbol }, id: string): Entity | undefined {
  return world.query(component as never).find((entity) => (world.get(entity, component as never) as T | undefined)?.id === id);
}
