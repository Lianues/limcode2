import { defineResource } from '../../ecs/types';
import type { StorageStateContributorRegistry } from './contributors';

export const StorageStateContributorsKey = defineResource<StorageStateContributorRegistry>('StorageStateContributors');
