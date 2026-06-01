import type { ClientState } from '../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../ecs/types';

export type StorageState = ClientState;
export type StorageStateSlice = Partial<StorageState>;
export type StorageStateProjector = (world: WorldReader) => StorageStateSlice;

export interface StorageStateContributor {
  readonly key: string;
  readonly reads?: AccessDeclaration;
  readonly project: StorageStateProjector;
}

export function defineStorageStateContributor(contributor: StorageStateContributor): StorageStateContributor {
  return contributor;
}

export class StorageStateContributorRegistry {
  private readonly contributors = new Map<string, StorageStateContributor>();

  public register(contributor: StorageStateContributor): void {
    this.contributors.set(contributor.key, contributor);
  }

  public list(): StorageStateContributor[] {
    return [...this.contributors.values()];
  }

  public reads(): AccessDeclaration {
    const components = this.list().flatMap((contributor) => contributor.reads?.components ?? []);
    const resources = this.list().flatMap((contributor) => contributor.reads?.resources ?? []);
    const events = this.list().flatMap((contributor) => contributor.reads?.events ?? []);
    const effects = this.list().flatMap((contributor) => contributor.reads?.effects ?? []);
    return { components, resources, events, effects };
  }
}
