import { defineResource } from '../../../ecs/types';
import type { PromptPlaceholderRecord } from '../../../../shared/protocol';

export const PromptPlaceholdersKey = defineResource<PromptPlaceholderRecord[]>('PromptPlaceholders');
