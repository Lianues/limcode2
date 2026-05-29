import { defineResource } from '../../../ecs/types';
import type { ToolSchema } from '../llm/contracts';

export const ToolSchemasKey = defineResource<ToolSchema[]>('ToolSchemas');
