import { defineResource } from '../../../ecs/types';
import type { RuleFileRecord } from '../../../../shared/protocol';

/** 磁盘扫描出的规则文件目录，由 BackendApplication 从 RulesCatalog capability 同步进来。 */
export const RulesCatalogKey = defineResource<RuleFileRecord[]>('RulesCatalog');
