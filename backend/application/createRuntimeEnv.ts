import * as vscode from 'vscode';
import {
  createLlmProviderCapability,
  createCommandCapability,
  createVsCodeFsCapability,
  createVsCodeStorageCapability,
  createWebviewCapability
} from '../capabilities';
import { createToolRegistry } from '../world/modules';
import type { ToolSchema } from '../world/modules/llm/contracts';
import type { RuntimeEnv } from './RuntimeEnv';

export interface RuntimeEnvSetup {
  env: RuntimeEnv;
  toolSchemas: ToolSchema[];
}

/**
 * Runtime capability 装配入口。
 * 只负责把 VS Code 侧能力实现组装成 RuntimeEnv，不包含领域规则。
 */
export function createRuntimeEnv(context: vscode.ExtensionContext): RuntimeEnvSetup {
  const command = createCommandCapability();
  const registry = createToolRegistry(command);
  const storage = createVsCodeStorageCapability(context);
  const llm = createLlmProviderCapability({
    settings: async () => {
      return storage.loadActiveLlmProviderConfig();
    },
    headers: { 'User-Agent': 'LimCode/0.0.1' }
  });
  const fs = createVsCodeFsCapability();
  const webview = createWebviewCapability();
  const toolSchemas = registry.schemas();

  return {
    env: {
      llm,
      fs,
      command,
      webview,
      storage,
      get paths() { return storage.paths; },
      tools: { registry: registry.list() }
    },
    toolSchemas
  };
}
