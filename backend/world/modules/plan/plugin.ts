import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { planReviewClientSyncContributor } from './clientSync';
import { planReviewStorageStateContributor } from './storageProjection';
import { registerPlanReviewSystems } from './systems';

export function planReviewPlugin(): WorldPlugin {
  return {
    name: 'planReview',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(planReviewClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(planReviewStorageStateContributor);
      registerPlanReviewSystems(ctx.scheduler);
    }
  };
}
