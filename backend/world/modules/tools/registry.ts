import type { FsCapability } from '../../../capabilities/types';

export interface ToolDeps {
  fs: FsCapability;
}

export interface ToolResultOut {
  ok: boolean;
  output: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
  execute(args: unknown, deps: ToolDeps): Promise<ToolResultOut>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  public register(def: ToolDefinition): this {
    this.tools.set(def.name, def);
    return this;
  }

  public get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  public schemas(): Array<{ name: string; description: string; parameters: unknown }> {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }
}
