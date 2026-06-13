import { defineResource } from '../../../ecs/types';
import type { ToolDefinitionRecord } from '../../../../shared/protocol';
import type { ToolSchema } from '../llm/contracts';

export const ToolSchemasKey = defineResource<ToolSchema[]>('ToolSchemas');
export const ToolDefinitionsKey = defineResource<ToolDefinitionRecord[]>('ToolDefinitions');
