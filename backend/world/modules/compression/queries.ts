import type { Entity, WorldReader } from '../../../ecs/types';
import { CompressionBlock } from './components';

export function hasActiveBlockingCompression(world: WorldReader, conversation: Entity): boolean {
  return world.query(CompressionBlock).some((entity) => {
    const block = world.get(entity, CompressionBlock);
    return block?.conversation === conversation
      && (block.status === 'pending' || block.status === 'running');
  });
}
