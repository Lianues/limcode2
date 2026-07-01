import { defineResource } from '../../../ecs/types';
import type { McpToolSourceRecord, ToolDefinitionRecord } from '../../../../shared/protocol';
import type { ToolSchema } from '../llm/contracts';
import type { ToolDefinition } from './registry';

export const ToolSchemasKey = defineResource<ToolSchema[]>('ToolSchemas');
export const ToolDefinitionsKey = defineResource<ToolDefinitionRecord[]>('ToolDefinitions');
export const ToolRuntimeDefinitionsKey = defineResource<ToolDefinition[]>('ToolRuntimeDefinitions');
export const McpToolSourcesKey = defineResource<McpToolSourceRecord[]>('McpToolSources');
