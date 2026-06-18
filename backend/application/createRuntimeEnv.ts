import * as vscode from 'vscode';
import type { ToolDefinitionRecord } from '../../shared/protocol';
import {
  createLlmProviderCapability,
  createCommandCapability,
  createWorkEnvironmentRuntimeCapability,
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
  toolDefinitions: ToolDefinitionRecord[];
}

/**
 * Runtime capability 装配入口。
 * 只负责把 VS Code 侧能力实现组装成 RuntimeEnv，不包含领域规则。
 */
export function createRuntimeEnv(context: vscode.ExtensionContext): RuntimeEnvSetup {
  const command = createCommandCapability();
  const workEnvironment = createWorkEnvironmentRuntimeCapability();
  const registry = createToolRegistry(command);
  const storage = createVsCodeStorageCapability(context);
  const llm = createLlmProviderCapability({
    settings: async (request) => {
      const override = request?.model;
      const base = override?.providerConfigId
        ? await storage.loadLlmProviderConfigById(override.providerConfigId) ?? await storage.loadActiveLlmProviderConfig(request?.conversationId)
        : await storage.loadActiveLlmProviderConfig(request?.conversationId);
      return {
        ...base,
        ...(override?.provider ? { provider: override.provider } : {}),
        ...(override?.model ? { model: override.model } : {})
      };
    },
    headers: { 'User-Agent': 'LimCode/0.0.1' }
  });
  const fs = createVsCodeFsCapability();
  const webview = createWebviewCapability();
  const toolSchemas = registry.schemas();
  const toolDefinitions = registry.records();

  return {
    env: {
      llm,
      fs,
      command,
      workEnvironment,
      webview,
      storage,
      get paths() { return storage.paths; },
      tools: { registry: registry.list() }
    },
    toolSchemas,
    toolDefinitions
  };
}
