import type { ClientPatchOp, ClientState } from '../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../ecs/types';

export type ClientStateSlice = Partial<ClientState>;

export type ClientStateProjector = (world: WorldReader) => ClientStateSlice;
export type ClientStateDiffer = (prev: ClientState, next: ClientState) => ClientPatchOp[];

export interface ClientStateContributorWorkerSpec {
  /** 相对 `backend/ecs/SystemWorker.js` 所在目录的 CommonJS module path，或绝对路径。 */
  readonly modulePath: string;
  readonly projectExport: string;
  readonly diffExport?: string;
}

export interface ClientStateContributor {
  readonly key: string;
  /** 这个 projection 会读取哪些 ECS 数据；ClientSyncSystem 会聚合这些 reads 参与拓扑编排。 */
  readonly reads?: AccessDeclaration;
  /** 主线程 fallback；worker 模式下不传输函数，只传 worker descriptor。 */
  readonly project?: ClientStateProjector;
  readonly diff?: ClientStateDiffer;
  /** 可序列化 projector/differ 位置，供 ClientSyncWorker 在 worker 内 require。 */
  readonly worker: ClientStateContributorWorkerSpec;
}

/** 可 structured-clone 的 contributor 描述。注意：不包含 reads，reads 里有 ComponentType/ResourceKey 的 symbol。 */
export interface ClientStateContributorDescriptor {
  readonly key: string;
  readonly worker: ClientStateContributorWorkerSpec;
}

export function defineClientStateContributor(contributor: ClientStateContributor): ClientStateContributor {
  return contributor;
}

export class ClientStateContributorRegistry {
  private readonly contributors = new Map<string, ClientStateContributor>();

  public register(contributor: ClientStateContributor): void {
    this.contributors.set(contributor.key, contributor);
  }

  public list(): ClientStateContributor[] {
    return [...this.contributors.values()];
  }

  /** 只返回可 structured-clone 的 descriptor，不包含 project/diff 函数，也不包含 symbol-bearing reads。 */
  public descriptors(): ClientStateContributorDescriptor[] {
    return this.list().map((contributor) => ({
      key: contributor.key,
      worker: contributor.worker
    }));
  }

  public reads(): AccessDeclaration {
    const components = this.list().flatMap((contributor) => contributor.reads?.components ?? []);
    const resources = this.list().flatMap((contributor) => contributor.reads?.resources ?? []);
    const events = this.list().flatMap((contributor) => contributor.reads?.events ?? []);
    const effects = this.list().flatMap((contributor) => contributor.reads?.effects ?? []);
    return { components, resources, events, effects };
  }
}
