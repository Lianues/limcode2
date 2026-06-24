import type { AccessDeclaration, ComponentType, Entity, ResourceKey, WorldReader } from '../../../ecs/types';
import type { ToolSchema } from '../llm/contracts';
import { workEnvironmentToolSchemaContributor } from '../workEnvironment/toolSchemaContributor';
import { editToolSchemaContributor } from './editToolSchemaContributor';

export interface ToolSchemaBuildContext {
  world: WorldReader;
  run: Entity;
  conversation: Entity;
}

export interface ToolSchemaContributor {
  key: string;
  reads?: AccessDeclaration;
  provide?(context: ToolSchemaBuildContext): ToolSchema[];
  augment?(tools: ToolSchema[], context: ToolSchemaBuildContext): ToolSchema[];
}

export const TOOL_SCHEMA_CONTRIBUTORS = [
  editToolSchemaContributor,
  workEnvironmentToolSchemaContributor
] as const satisfies readonly ToolSchemaContributor[];

export const TOOL_SCHEMA_CONTRIBUTOR_READS: AccessDeclaration = mergeContributorReads(TOOL_SCHEMA_CONTRIBUTORS);

export function buildRuntimeToolSchemas(baseTools: ToolSchema[], context: ToolSchemaBuildContext): ToolSchema[] {
  const provided = TOOL_SCHEMA_CONTRIBUTORS.flatMap((contributor) => contributor.provide?.(context) ?? []);
  let tools = dedupeToolSchemas([...baseTools, ...provided]);
  for (const contributor of TOOL_SCHEMA_CONTRIBUTORS) {
    tools = dedupeToolSchemas(contributor.augment?.(tools, context) ?? tools);
  }
  return tools;
}

function mergeContributorReads(contributors: readonly ToolSchemaContributor[]): AccessDeclaration {
  const components: ComponentType<unknown>[] = [];
  const resources: ResourceKey<unknown>[] = [];
  const events: string[] = [];
  const effects: string[] = [];

  for (const contributor of contributors) {
    pushUnique(components, contributor.reads?.components ?? [], (item) => item.id);
    pushUnique(resources, contributor.reads?.resources ?? [], (item) => item.id);
    pushUnique(events, contributor.reads?.events ?? [], (item) => item);
    pushUnique(effects, contributor.reads?.effects ?? [], (item) => item);
  }

  return {
    ...(components.length > 0 ? { components } : {}),
    ...(resources.length > 0 ? { resources } : {}),
    ...(events.length > 0 ? { events } : {}),
    ...(effects.length > 0 ? { effects } : {})
  };
}

function pushUnique<T, TKey>(target: T[], values: readonly T[], keyOf: (value: T) => TKey): void {
  const keys = new Set(target.map(keyOf));
  for (const value of values) {
    const key = keyOf(value);
    if (keys.has(key)) continue;
    keys.add(key);
    target.push(value);
  }
}

function dedupeToolSchemas(tools: ToolSchema[]): ToolSchema[] {
  const byName = new Map<string, ToolSchema>();
  for (const tool of tools) byName.set(tool.name, tool);
  return [...byName.values()];
}
