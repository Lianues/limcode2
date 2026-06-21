import * as vscode from 'vscode';
import type { LlmCompressionConfigRecord, LlmInvocationSettingsSnapshotRecord, LlmProviderConfigRecord, ToolDefinitionRecord } from '../../shared/protocol';
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
      if (request && 'settingsSnapshot' in request && request.settingsSnapshot) return resolveSnapshotLlmProviderConfig(storage, request.settingsSnapshot, request.conversationId);
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
    compressionSettings: async (request) => {
      const activeProvider = await storage.loadActiveLlmProviderConfig(request.conversationId);
      const config = request.methodConfigId
        ? await storage.loadLlmCompressionConfigById(request.methodConfigId)
        : await storage.loadActiveLlmCompressionConfig(activeProvider.id);
      return coerceCompressionConfigForProvider(config, activeProvider);
    },
    activeCompressionSettings: async (conversationId) => {
      const activeProvider = await storage.loadActiveLlmProviderConfig(conversationId);
      return coerceCompressionConfigForProvider(await storage.loadActiveLlmCompressionConfig(activeProvider.id), activeProvider);
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

function coerceCompressionConfigForProvider(
  config: LlmCompressionConfigRecord | undefined,
  provider: LlmProviderConfigRecord
): LlmCompressionConfigRecord | undefined {
  if (!config) return undefined;
  if (provider.provider === 'openai-responses' || config.kind !== 'openai_responses_compact') return config;
  return { ...config, kind: 'llm_summary' };
}

async function resolveSnapshotLlmProviderConfig(
  storage: ReturnType<typeof createVsCodeStorageCapability>,
  snapshot: LlmInvocationSettingsSnapshotRecord,
  conversationId: string | undefined
): Promise<LlmProviderConfigRecord> {
  const storedConfig = snapshot.providerConfigId ? await storage.loadLlmProviderConfigById(snapshot.providerConfigId) : undefined;
  const base = storedConfig ?? await storage.loadActiveLlmProviderConfig(conversationId);
  const modelId = snapshot.modelId ?? base.model;
  const modelName = snapshot.modelName ?? snapshot.displayModelName ?? modelId;
  return {
    ...base,
    apiKey: storedConfig?.apiKey ?? (!snapshot.providerConfigId ? base.apiKey : ''),
    headers: storedConfig?.headers ?? (!snapshot.providerConfigId ? base.headers : undefined),
    id: snapshot.providerConfigId ?? base.id,
    name: snapshot.providerConfigName ?? base.name,
    ...(snapshot.provider ? { provider: snapshot.provider } : {}),
    ...(snapshot.baseUrl ? { baseUrl: snapshot.baseUrl } : {}),
    model: modelId,
    models: modelId ? [{ id: modelId, name: modelName }, ...base.models.filter((model) => model.id !== modelId)] : base.models,
    ...(snapshot.toolCallFormat ? { toolCallFormat: snapshot.toolCallFormat } : {}),
    ...(snapshot.stream !== undefined ? { stream: snapshot.stream } : {}),
    ...(snapshot.generationConfig ? { generationConfig: snapshot.generationConfig } : {}),
    ...(snapshot.requestBody ? { requestBody: snapshot.requestBody } : {})
  };
}
