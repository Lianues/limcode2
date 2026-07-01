import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { skillClientSyncContributor } from './clientSync';
import { skillStorageStateContributor } from './storageProjection';
import { SkillCatalogKey } from './resources';
import { registerSkillSystems } from './systems';

export function skillPlugin(): WorldPlugin {
  return {
    name: 'skill',
    install(ctx) {
      ctx.world.setResource(SkillCatalogKey, []);
      ctx.world.getResource(ClientStateContributorsKey).register(skillClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(skillStorageStateContributor);
      registerSkillSystems(ctx.scheduler);
    }
  };
}
