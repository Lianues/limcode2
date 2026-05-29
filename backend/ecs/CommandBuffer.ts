import type {
  CommandSink,
  ComponentType,
  Entity,
  ResourceKey,
  WorldCommand,
  WorldEvent
} from './types';

export interface EntityAllocator {
  reserveEntity(): Entity;
}

/**
 * 每个 System 一份的延迟写入缓冲。
 * System 运行时只收集命令；Scheduler 在 wave 边界按稳定顺序统一 commit。
 */
export class CommandBuffer implements CommandSink {
  private readonly queue: WorldCommand[] = [];

  public constructor(private readonly allocator: EntityAllocator) {}

  public spawn(): Entity {
    const entity = this.allocator.reserveEntity();
    this.queue.push({ kind: 'spawn', entity });
    return entity;
  }

  public despawn(entity: Entity): void {
    this.queue.push({ kind: 'despawn', entity });
  }

  public add<T>(entity: Entity, component: ComponentType<T>, value: T): void {
    this.queue.push({ kind: 'add', entity, component: component as ComponentType<unknown>, value });
  }

  public remove<T>(entity: Entity, component: ComponentType<T>): void {
    this.queue.push({ kind: 'remove', entity, component: component as ComponentType<unknown> });
  }

  public setResource<T>(key: ResourceKey<T>, value: T): void {
    this.queue.push({ kind: 'setResource', key: key as ResourceKey<unknown>, value });
  }

  public enqueue<T>(event: WorldEvent<T>): void {
    this.queue.push({ kind: 'enqueue', event });
  }

  public effect(effect: unknown): void {
    this.queue.push({ kind: 'effect', effect });
  }

  public commands(): readonly WorldCommand[] {
    return this.queue;
  }

  public get isEmpty(): boolean {
    return this.queue.length === 0;
  }
}
