import type { CommandCapability, FsCapability } from '../../../capabilities/types';
import type { ToolCallEventKind, ToolDefinitionMetadataRecord, ToolDefinitionRecord, ToolExecutionKind } from '../../../../shared/protocol';

export interface ToolDeps {
  fs: FsCapability;
  command: CommandCapability;
}

export interface ToolResultOut {
  ok: boolean;
  output: string;
}

export interface ToolRuntimeEvent {
  kind: Extract<ToolCallEventKind, 'stdout' | 'stderr' | 'progress'>;
  delta?: string;
  progress?: unknown;
  payload?: unknown;
}

export interface ToolExecutionContext {
  toolCallId: string;
  runId?: string;
  conversationId?: string;
  emit(event: ToolRuntimeEvent): void;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: unknown;
  metadata?: ToolDefinitionMetadataRecord;
}

export interface RuntimeToolDefinition {
  declaration: ToolDeclaration;
  execution: 'runtime';
  execute(args: unknown, deps: ToolDeps, ctx?: ToolExecutionContext): Promise<ToolResultOut>;
}

export interface AgentRunToolDefinition {
  declaration: ToolDeclaration;
  execution: 'agentRun';
}

export type ToolDefinition = RuntimeToolDefinition | AgentRunToolDefinition;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  public register(def: ToolDefinition): this {
    this.tools.set(def.declaration.name, def);
    return this;
  }

  public registerMany(definitions: readonly ToolDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  public get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  public schemas(): ToolDeclaration[] {
    return this.list().map((tool) => tool.declaration);
  }

  public records(): ToolDefinitionRecord[] {
    return this.list().map((tool) => toolDefinitionRecord(tool));
  }
}

export function toolDefinitionRecord(tool: ToolDefinition): ToolDefinitionRecord {
  return {
    id: tool.declaration.name,
    name: tool.declaration.name,
    description: tool.declaration.description,
    parameters: tool.declaration.parameters,
    execution: tool.execution as ToolExecutionKind,
    ...(tool.declaration.metadata ? { metadata: tool.declaration.metadata } : {})
  };
}
