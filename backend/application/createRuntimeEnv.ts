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

  return {
    env: {
      llm: createLlmProviderCapability({
        settings: async () => {
          const stored = await storage.loadGlobalSettings('llm');
          return stored.settings as import('../../shared/protocol').LlmSettingsRecord;
        }
      }),
      fs: createVsCodeFsCapability(),
      command,
      webview: createWebviewCapability(),
      storage,
      get paths() { return storage.paths; },
      tools: { registry: registry.list() }
    },
    toolSchemas: registry.schemas()
  };
}
