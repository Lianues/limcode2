import type { Entity, WorldReader } from '../../../ecs/types';
import { Message, PartOf } from './components';

export function conversationMessages(world: WorldReader, conversationEntity: Entity): Entity[] {
  return world
    .query(Message, PartOf)
    .filter((entity) => world.get(entity, PartOf)?.parent === conversationEntity)
    .sort((a, b) => (world.get(a, Message)?.seq ?? 0) - (world.get(b, Message)?.seq ?? 0));
}
