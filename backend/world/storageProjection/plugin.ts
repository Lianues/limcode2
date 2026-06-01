import type { WorldPlugin } from '../plugin';
import { StorageStateContributorRegistry } from './contributors';
import { StorageStateContributorsKey } from './resources';

export function storageProjectionPlugin(): WorldPlugin {
  return {
    name: 'storageProjection',
    install(ctx) {
      ctx.world.setResource(StorageStateContributorsKey, new StorageStateContributorRegistry());
    }
  };
}
