import type { ToolDefinition } from '../world/modules/tools/registry';
import type { CommandCapability, FsCapability, LlmCapability, RuntimePaths, StorageCapability, WebviewCapability } from '../capabilities/types';

export type { Emit } from '../capabilities/types';

export interface ToolCapability {
  registry: ToolDefinition[];
}

/**
 * RuntimeEnv = 外部能力单例容器（runtime resource/capability registry）。
 * 注意：System 拿不到 RuntimeEnv；只有 executeEffects 使用它。
 */
export interface RuntimeEnv {
  llm: LlmCapability;
  fs: FsCapability;
  command: CommandCapability;
  webview: WebviewCapability;
  storage: StorageCapability;
  paths: RuntimePaths;
  tools: ToolCapability;
}
