/**
 * ECS 引擎稳定契约（领域无关）。
 * 系统只依赖这里的接口；将来替换 World 的具体实现（如 archetype 版）时，系统代码零改动。
 */

export type Entity = number;

/** 组件类型句柄。`__t` 仅用于编译期携带数据类型 T，运行期只用到 id/name。 */
export interface ComponentType<T> {
  readonly id: symbol;
  readonly name: string;
  readonly __t?: T;
}

const componentRegistry = new Map<string, ComponentType<unknown>>();

export function defineComponent<T>(name: string): ComponentType<T> {
  const component = { id: Symbol(name), name };
  componentRegistry.set(name, component);
  return component;
}

export function getComponentByName(name: string): ComponentType<unknown> | undefined {
  return componentRegistry.get(name);
}

/** 资源（单例）句柄：用于注入 drivers、配置、同步状态等。 */
export interface ResourceKey<T> {
  readonly id: symbol;
  readonly name: string;
  readonly __t?: T;
}

const resourceRegistry = new Map<string, ResourceKey<unknown>>();

export function defineResource<T>(name: string): ResourceKey<T> {
  const resource = { id: Symbol(name), name };
  resourceRegistry.set(name, resource);
  return resource;
}

export function getResourceByName(name: string): ResourceKey<unknown> | undefined {
  return resourceRegistry.get(name);
}

/** 世界事件：drivers / 系统把"外部输入"和"异步完成结果"回灌进 World 的统一载体。 */
export interface WorldEvent<T = unknown> {
  readonly type: string;
  readonly payload: T;
}

/** 只读 World 视图：System 运行时只能通过它读取，不应该直接修改 World。 */
export interface WorldReader {
  get<T>(entity: Entity, component: ComponentType<T>): T | undefined;
  has(entity: Entity, component: ComponentType<unknown>): boolean;
  /** 组件交集查询，返回同时拥有全部给定组件的实体。 */
  query(...components: ComponentType<unknown>[]): Entity[];
  /** 取资源，不存在则抛错。 */
  getResource<T>(key: ResourceKey<T>): T;
  /** 取资源，不存在返回 undefined。 */
  tryGetResource<T>(key: ResourceKey<T>): T | undefined;
  /** 变更计数，供调度器判定是否到达不动点。 */
  version(): number;
  /** 指定 component 类型自进程启动以来的结构/值写入版本。用于廉价 projection dirty 判断。 */
  componentVersion(component: ComponentType<unknown>): number;
  /** 指定 resource 自进程启动以来的写入版本。用于廉价 projection dirty 判断。 */
  resourceVersion(resource: ResourceKey<unknown>): number;
}

/** 面向应用组合根/插件安装的可写 World 接口。System 内不要直接依赖它。 */
export interface World extends WorldReader {
  spawn(): Entity;
  despawn(entity: Entity): void;
  add<T>(entity: Entity, component: ComponentType<T>, value: T): void;
  remove<T>(entity: Entity, component: ComponentType<T>): void;
  /** 入队世界事件（会唤醒调度器）。 */
  enqueue<T>(event: WorldEvent<T>): void;
  setResource<T>(key: ResourceKey<T>, value: T): void;
}

export type WorldCommand =
  | { readonly kind: 'spawn'; readonly entity: Entity }
  | { readonly kind: 'despawn'; readonly entity: Entity }
  | { readonly kind: 'add'; readonly entity: Entity; readonly component: ComponentType<unknown>; readonly value: unknown }
  | { readonly kind: 'remove'; readonly entity: Entity; readonly component: ComponentType<unknown> }
  | { readonly kind: 'setResource'; readonly key: ResourceKey<unknown>; readonly value: unknown }
  | { readonly kind: 'enqueue'; readonly event: WorldEvent }
  | { readonly kind: 'effect'; readonly effect: unknown };

/** System 的唯一写出口。Scheduler 会在 wave 边界统一提交这些命令，方便未来并行化。 */
export interface CommandSink {
  spawn(): Entity;
  despawn(entity: Entity): void;
  add<T>(entity: Entity, component: ComponentType<T>, value: T): void;
  remove<T>(entity: Entity, component: ComponentType<T>): void;
  setResource<T>(key: ResourceKey<T>, value: T): void;
  enqueue<T>(event: WorldEvent<T>): void;
  effect(effect: unknown): void;
}

/** 调度器使用的扩展接口（不暴露给业务系统）。 */
export interface SchedulerWorld extends World {
  drainQueue(): WorldEvent[];
  setWake(wake: () => void): void;
  pendingCount(): number;
  reserveEntity(): Entity;
  snapshot(filter?: WorldSnapshotFilter): WorldSnapshot;
  commit(commands: readonly WorldCommand[], applyEffect: (effect: unknown) => void): void;
}

export interface WorldSnapshotFilter {
  readonly components?: readonly ComponentType<unknown>[];
  readonly resources?: readonly ResourceKey<unknown>[];
}

export interface WorldSnapshotComponentStore {
  readonly name: string;
  readonly values: ReadonlyArray<readonly [Entity, unknown]>;
}

export interface WorldSnapshotResourceValue {
  readonly name: string;
  readonly value: unknown;
}

export interface WorldSnapshotVersionValue {
  readonly name: string;
  readonly version: number;
}

export interface WorldSnapshot {
  readonly version: number;
  readonly entities: readonly Entity[];
  readonly components: readonly WorldSnapshotComponentStore[];
  readonly resources: readonly WorldSnapshotResourceValue[];
  readonly componentVersions: readonly WorldSnapshotVersionValue[];
  readonly resourceVersions: readonly WorldSnapshotVersionValue[];
}

export interface SystemContext {
  /** 本轮（pass）开始时排空的事件快照。 */
  readonly events: ReadonlyArray<WorldEvent>;
}

export interface SystemShouldRunContext extends SystemContext {
  /** 用于在真正运行 system 前做廉价只读工作量判断。 */
  readonly world: WorldReader;
}

export interface SystemRunContext extends SystemContext {
  /** System 的只读 World 视图。 */
  readonly world: WorldReader;
  /** System 的延迟写入缓冲。 */
  readonly cmd: CommandSink;
}

export type QueryRole = 'work' | 'lookup';

/**
 * 写入模式是声明项级别的整体语义，而不是逐 component 标注。
 * Scheduler 用它做更细的串并行判断：例如 create 表示只写新实体，可与其他 create/update 基于同一 snapshot 并行。
 */
export type MutationMode = 'create' | 'update' | 'consume' | 'delete' | 'append';

export interface QueryAccess {
  readonly name?: string;
  readonly all?: readonly ComponentType<unknown>[];
  readonly any?: readonly ComponentType<unknown>[];
  readonly none?: readonly ComponentType<unknown>[];
  /** 本 query 会读取的数据；未填写时默认取 all/any。 */
  readonly read?: readonly ComponentType<unknown>[];
  /** 本 query 会覆盖写入的数据。 */
  readonly write?: readonly ComponentType<unknown>[];
  /** 本 query 可能 add 的组件。 */
  readonly add?: readonly ComponentType<unknown>[];
  /** 本 query 可能 remove 的组件。 */
  readonly remove?: readonly ComponentType<unknown>[];
  /** read/write/add/remove 的整体写入语义；未声明时按 update 保守处理。 */
  readonly mutationMode?: MutationMode;
  /** work query 参与数据流拓扑；lookup query 只参与并行冲突分析。 */
  readonly role?: QueryRole;
}

export interface BundleAccess {
  readonly name: string;
  readonly reads?: readonly ComponentType<unknown>[];
  readonly writes?: readonly ComponentType<unknown>[];
  /** Bundle 内 writes 的整体语义；spawn bundle 通常是 create。 */
  readonly mutationMode?: MutationMode;
  readonly spawns?: boolean;
  readonly despawns?: boolean;
}

export interface AccessDeclaration {
  readonly components?: readonly ComponentType<unknown>[];
  readonly resources?: readonly ResourceKey<unknown>[];
  readonly events?: readonly string[];
  readonly effects?: readonly string[];
  /** 当这个 declaration 用在 writes 上时，表示其中所有写入的整体模式。 */
  readonly mutationMode?: MutationMode;
}

export interface SystemAccess {
  /** System 内所有声明式 query。 */
  readonly queries?: readonly QueryAccess[];
  /** 非 query 的显式读取，例如全局投影读取的组件、事件读取等。 */
  readonly reads?: AccessDeclaration;
  /** 非 query/bundle 的显式写入。 */
  readonly writes?: AccessDeclaration;
  /** 资源访问。 */
  readonly resources?: {
    readonly read?: readonly ResourceKey<unknown>[];
    readonly write?: readonly ResourceKey<unknown>[];
    readonly mutationMode?: MutationMode;
  };
  /** 事件访问。read 表示消费 ctx.events；emit 表示通过 cmd.enqueue 回灌事件。 */
  readonly events?: {
    readonly read?: readonly string[];
    readonly emit?: readonly string[];
  };
  /** 通过 CommandBuffer 产出的 effect。 */
  readonly effects?: {
    readonly emit?: readonly string[];
  };
  /** System 调用的 bundle/helper，其读写会合并到 system access。 */
  readonly bundles?: readonly BundleAccess[];
  /** 少量无法通过访问声明表达的人工约束。 */
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export type SystemAccessProvider = SystemAccess | ((world: WorldReader) => SystemAccess);

export interface SystemWorkerSpec {
  /** 相对 `backend/ecs/SystemWorker.js` 所在目录的 CommonJS module path，或绝对路径。 */
  readonly modulePath: string;
  readonly exportName: string;
  /** 可选：主线程在创建 worker 前根据当前 world/events/snapshot 生成可 clone 的 payload。 */
  readonly payload?: (ctx: {
    readonly world: WorldReader;
    readonly events: ReadonlyArray<WorldEvent>;
    readonly snapshot: WorldSnapshot;
  }) => unknown;
}

/** 系统：纯逻辑，必须同步、绝不 await；I/O 一律通过 cmd.effect 交给 application/capability。 */
export interface System {
  readonly name: string;
  readonly access?: SystemAccessProvider;
  /** 可选：允许 Scheduler 把该 system 放到 Node worker_threads 中真正并行执行。 */
  readonly worker?: SystemWorkerSpec;
  /** 可选：在创建 CommandBuffer/snapshot/worker task 前判断本 pass 是否有真实工作。 */
  shouldRun?(ctx: SystemShouldRunContext): boolean;
  run(ctx: SystemRunContext): void;
}

export function defineQuery(access: QueryAccess): QueryAccess {
  return access;
}

export function defineBundle(access: BundleAccess): BundleAccess {
  return access;
}

export function defineSystem(system: System): System {
  return system;
}
