import type { CommandCapability } from '../../../../capabilities/types';
import type { ToolDefinition } from '../registry';

/**
 * 工具定义创建上下文。
 * 只放启动期决定工具声明所需的数据，运行期外部能力仍通过 ToolDeps 注入给 execute。
 */
export interface ToolDefinitionContext {
  readonly command: CommandCapability;
}

/**
 * 单个工具模块的固定接口。
 * 后续新增工具时，优先新增 definitions/<tool>/index.ts 并导出一个 ToolDefinitionModule。
 */
export interface ToolDefinitionModule {
  readonly id: string;
  create(context: ToolDefinitionContext): ToolDefinition;
}

export function defineToolDefinitionModule(module: ToolDefinitionModule): ToolDefinitionModule {
  return module;
}
