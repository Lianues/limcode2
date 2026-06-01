import {
  ComponentType,
  Entity,
  ResourceKey,
  SchedulerWorld,
  WorldEvent,
  WorldCommand,
  WorldSnapshot,
  WorldSnapshotFilter
} from './types';

/**
 * 最简单的 Map 实现：component-keyed 存储。
 * 简单够用，且因系统只依赖 World 接口，将来可替换为更高性能实现（如 archetype）而不影响系统。
 */
export class MapWorld implements SchedulerWorld {
  private nextEntity = 1;
  private readonly alive = new Set<Entity>();
  private readonly stores = new Map<symbol, Map<Entity, unknown>>();
  private readonly resources = new Map<symbol, unknown>();
  private readonly componentVersions = new Map<symbol, number>();
  private readonly resourceVersions = new Map<symbol, number>();
  private queue: WorldEvent[] = [];
  private _version = 0;
  private wake: () => void = () => undefined;

  public spawn(): Entity {
    const entity = this.reserveEntity();
    this.activate(entity);
    return entity;
  }

  public reserveEntity(): Entity {
    return this.nextEntity++;
  }

  private activate(entity: Entity): void {
    if (this.alive.has(entity)) {
      return;
    }
    this.alive.add(entity);
    this._version++;
  }

  public despawn(entity: Entity): void {
    if (!this.alive.delete(entity)) {
      return;
    }
    for (const [componentId, store] of this.stores) {
      if (store.delete(entity)) {
        this.bumpComponentId(componentId);
      }
    }
    this._version++;
  }

  public add<T>(entity: Entity, component: ComponentType<T>, value: T): void {
    this.storeOf(component).set(entity, value);
    this.bumpComponent(component);
    this._version++;
  }

  public remove<T>(entity: Entity, component: ComponentType<T>): void {
    const store = this.stores.get(component.id);
    if (store && store.delete(entity)) {
      this.bumpComponent(component);
      this._version++;
    }
  }

  public get<T>(entity: Entity, component: ComponentType<T>): T | undefined {
    return this.stores.get(component.id)?.get(entity) as T | undefined;
  }

  public has(entity: Entity, component: ComponentType<unknown>): boolean {
    return this.stores.get(component.id)?.has(entity) ?? false;
  }

  public query(...components: ComponentType<unknown>[]): Entity[] {
    if (components.length === 0) {
      return [...this.alive];
    }

    const maps: Array<Map<Entity, unknown>> = [];
    for (const component of components) {
      const store = this.stores.get(component.id);
      if (!store || store.size === 0) {
        return [];
      }
      maps.push(store);
    }

    // 从最小的表开始遍历，再用其余表做 has 过滤。
    let smallest = maps[0];
    for (const map of maps) {
      if (map.size < smallest.size) {
        smallest = map;
      }
    }

    const result: Entity[] = [];
    outer: for (const entity of smallest.keys()) {
      for (const map of maps) {
        if (map !== smallest && !map.has(entity)) {
          continue outer;
        }
      }
      result.push(entity);
    }
    return result;
  }

  public enqueue<T>(event: WorldEvent<T>): void {
    this.queue.push(event);
    this._version++;
    this.wake();
  }

  public drainQueue(): WorldEvent[] {
    if (this.queue.length === 0) {
      return [];
    }
    const queue = this.queue;
    this.queue = [];
    return queue;
  }

  public pendingCount(): number {
    return this.queue.length;
  }

  public setWake(wake: () => void): void {
    this.wake = wake;
  }

  public getResource<T>(key: ResourceKey<T>): T {
    if (!this.resources.has(key.id)) {
      throw new Error(`Resource not found: ${key.name}`);
    }
    return this.resources.get(key.id) as T;
  }

  public tryGetResource<T>(key: ResourceKey<T>): T | undefined {
    return this.resources.get(key.id) as T | undefined;
  }

  public setResource<T>(key: ResourceKey<T>, value: T): void {
    this.resources.set(key.id, value);
    this.bumpResource(key);
    this._version++;
  }

  public version(): number {
    return this._version;
  }

  public componentVersion(component: ComponentType<unknown>): number {
    return this.componentVersions.get(component.id) ?? 0;
  }

  public resourceVersion(resource: ResourceKey<unknown>): number {
    return this.resourceVersions.get(resource.id) ?? 0;
  }

  public commit(commands: readonly WorldCommand[], applyEffect: (effect: unknown) => void): void {
    for (const command of commands) {
      switch (command.kind) {
        case 'spawn':
          this.activate(command.entity);
          break;
        case 'despawn':
          this.despawn(command.entity);
          break;
        case 'add':
          this.add(command.entity, command.component, command.value);
          break;
        case 'remove':
          this.remove(command.entity, command.component);
          break;
        case 'setResource':
          this.setResource(command.key, command.value);
          break;
        case 'enqueue':
          this.enqueue(command.event);
          break;
        case 'effect':
          applyEffect(command.effect);
          break;
        default:
          assertNever(command);
      }
    }
  }

  public snapshot(filter: WorldSnapshotFilter = {}): WorldSnapshot {
    const componentIds = filter.components ? new Set(filter.components.map((component) => component.id)) : undefined;
    const resourceIds = filter.resources ? new Set(filter.resources.map((resource) => resource.id)) : undefined;

    const components: Array<WorldSnapshot['components'][number]> = [];
    for (const [id, store] of this.stores) {
      if (componentIds && !componentIds.has(id)) continue;
      const component = filter.components?.find((candidate) => candidate.id === id);
      if (!component) continue;
      components.push({ name: component.name, values: [...store.entries()] });
    }

    const resources: Array<WorldSnapshot['resources'][number]> = [];
    for (const [id, value] of this.resources) {
      if (resourceIds && !resourceIds.has(id)) continue;
      const resource = filter.resources?.find((candidate) => candidate.id === id);
      if (!resource) continue;
      resources.push({ name: resource.name, value });
    }

    return {
      version: this._version,
      entities: [...this.alive],
      components,
      resources,
      componentVersions: (filter.components ?? []).map((component) => ({
        name: component.name,
        version: this.componentVersion(component)
      })),
      resourceVersions: (filter.resources ?? []).map((resource) => ({
        name: resource.name,
        version: this.resourceVersion(resource)
      }))
    };
  }

  private storeOf(component: ComponentType<unknown>): Map<Entity, unknown> {
    let store = this.stores.get(component.id);
    if (!store) {
      store = new Map<Entity, unknown>();
      this.stores.set(component.id, store);
    }
    return store;
  }

  private bumpComponent(component: ComponentType<unknown>): void {
    this.bumpComponentId(component.id);
  }

  private bumpComponentId(componentId: symbol): void {
    this.componentVersions.set(componentId, (this.componentVersions.get(componentId) ?? 0) + 1);
  }

  private bumpResource(resource: ResourceKey<unknown>): void {
    this.resourceVersions.set(resource.id, (this.resourceVersions.get(resource.id) ?? 0) + 1);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected world command: ${String(value)}`);
}
