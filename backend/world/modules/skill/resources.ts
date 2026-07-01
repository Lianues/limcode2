import { defineResource } from '../../../ecs/types';
import type { SkillDefinitionRecord } from '../../../../shared/protocol';

/** 磁盘扫描出的技能目录，由 BackendApplication 从 SkillCatalog capability 同步进来。 */
export const SkillCatalogKey = defineResource<SkillDefinitionRecord[]>('SkillCatalog');
