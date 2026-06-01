import type {
  ComponentType,
  Entity,
  ResourceKey,
  WorldReader,
  WorldSnapshot
} from './types';

/** 从可结构化克隆的 WorldSnapshot 重建只读 World。用于 worker_threads 中运行纯 system。 */
export class SnapshotWorldReader implements WorldReader {
  private readonly alive: Set<Entity>;
  private readonly stores = new Map<string, Map<Entity, unknown>>();
  private readonly resources = new Map<string, unknown>();
  private readonly componentVersions = new Map<string, number>();
  private readonly resourceVersions = new Map<string, number>();

  public constructor(private readonly snap: WorldSnapshot) {
    this.alive = new Set(snap.entities);

    for (const store of snap.components) {
      this.stores.set(store.name, new Map(store.values));
    }

    for (const item of snap.resources) {
      this.resources.set(item.name, item.value);
    }

    for (const item of snap.componentVersions) this.componentVersions.set(item.name, item.version);
    for (const item of snap.resourceVersions) this.resourceVersions.set(item.name, item.version);
  }

  public get<T>(entity: Entity, component: ComponentType<T>): T | undefined {
    return this.stores.get(component.name)?.get(entity) as T | undefined;
  }

  public has(entity: Entity, component: ComponentType<unknown>): boolean {
    return this.stores.get(component.name)?.has(entity) ?? false;
  }

  public query(...components: ComponentType<unknown>[]): Entity[] {
    if (components.length === 0) {
      return [...this.alive];
    }

    const maps: Array<Map<Entity, unknown>> = [];
    for (const component of components) {
      const store = this.stores.get(component.name);
      if (!store || store.size === 0) {
        return [];
      }
      maps.push(store);
    }

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

  public getResource<T>(key: ResourceKey<T>): T {
    if (!this.resources.has(key.name)) {
      throw new Error(`Resource not found in snapshot: ${key.name}`);
    }
    return this.resources.get(key.name) as T;
  }

  public tryGetResource<T>(key: ResourceKey<T>): T | undefined {
    return this.resources.get(key.name) as T | undefined;
  }

  public version(): number {
    return this.snap.version;
  }

  public componentVersion(component: ComponentType<unknown>): number {
    return this.componentVersions.get(component.name) ?? 0;
  }

  public resourceVersion(resource: ResourceKey<unknown>): number {
    return this.resourceVersions.get(resource.name) ?? 0;
  }
}
