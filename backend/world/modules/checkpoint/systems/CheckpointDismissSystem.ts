import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Checkpoint, CheckpointTimelineAnchor } from '../components';
import { CheckpointEventType } from '../events';
import { CheckpointBundle } from '../bundles';

/** 移除单个存档点记录及其时间线锚点（用于用户手动叉掉跳过/失败的存档点）。shadow 仓库与 link 不动。 */
export const CheckpointDismissSystem = defineSystem({
  name: 'CheckpointDismissSystem',
  shouldRun(ctx) {
    return readEvents(ctx, CheckpointEventType.DismissRequested).length > 0;
  },
  access: {
    reads: { components: [Checkpoint, CheckpointTimelineAnchor] },
    bundles: [CheckpointBundle],
    events: { read: [CheckpointEventType.DismissRequested] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, CheckpointEventType.DismissRequested)) {
      const checkpointEntity = findCheckpointById(world, payload.checkpointId);
      if (checkpointEntity === undefined) continue;
      for (const anchorEntity of world.query(CheckpointTimelineAnchor)) {
        if (world.get(anchorEntity, CheckpointTimelineAnchor)?.checkpoint === checkpointEntity) {
          cmd.despawn(anchorEntity);
        }
      }
      cmd.despawn(checkpointEntity);
    }
  }
});

function findCheckpointById(world: WorldReader, id: string): Entity | undefined {
  return world.query(Checkpoint).find((entity) => world.get(entity, Checkpoint)?.id === id);
}
