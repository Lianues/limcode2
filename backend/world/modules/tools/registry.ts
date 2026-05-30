import type { CommandCapability, FsCapability } from '../../../capabilities/types';

export interface ToolDeps {
  fs: FsCapability;
  command: CommandCapability;
}

export interface ToolResultOut {
  ok: boolean;
  output: string;
}

/** LLM 可见的工具声明。后续 provider/schema 转换只应依赖这一层声明。 */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

/** 工具运行定义 = 稳定声明 + 运行期 handler。 */
export interface ToolDefinition {
  declaration: ToolDeclaration;
  execute(args: unknown, deps: ToolDeps): Promise<ToolResultOut>;
}

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
}
