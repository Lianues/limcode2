import * as vscode from 'vscode';
import type { GlobalSettingsRecord, LlmCompressionConfigRecord, LlmInvocationSettingsSnapshotRecord, LlmProviderConfigRecord, ToolDefinitionRecord } from '../../shared/protocol';
import {
  createLlmProviderCapability,
  createCommandCapability,
  createWorkEnvironmentRuntimeCapability,
  createVsCodeFsCapability,
  createVsCodeStorageCapability,
  createWebviewCapability,
  createSkillCatalogCapability,
  createRulesCatalogCapability
} from '../capabilities';
import { createGlobalSettingsRecord } from '../capabilities/vscodeStorage/globalStatus';
import { resolveAttachmentForClient } from '../capabilities/vscodeStorage/attachmentStore';
import { createToolRegistry } from '../world/modules';
import type { ToolSchema } from '../world/modules/llm/contracts';
import { toolDefinitionRecord, type ToolDefinition } from '../world/modules/tools/registry';
import type { RuntimeEnv } from './RuntimeEnv';
import { McpRuntimeManager } from './mcpRuntimeManager';

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
  const storage = createVsCodeStorageCapability(context);
  const command = createCommandCapability({ paths: () => storage.paths });
  const workEnvironment = createWorkEnvironmentRuntimeCapability();
  const registry = createToolRegistry(command);
  const mcp = new McpRuntimeManager(storage);
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
    headers: { 'User-Agent': 'LimCode/0.0.1' },
    proxy: async () => createGlobalSettingsRecord(context).proxy || undefined,
    resolveAttachment: async (input) => {
      const result = await resolveAttachmentForClient(storage.paths, input);
      return result.status === 'available' ? result.part : undefined;
    }
  });
  const fs = createVsCodeFsCapability();
  const webview = createWebviewCapability();
  const skills = createSkillCatalogCapability(context);
  const rules = createRulesCatalogCapability(context);
  const toolRuntimeDefinitions = registry.list();
  const toolSchemas = schemasForTools(toolRuntimeDefinitions);
  const toolDefinitions = recordsForTools(toolRuntimeDefinitions);

  return {
    env: {
      llm,
      fs,
      command,
      workEnvironment,
      webview,
      storage,
      get paths() { return storage.paths; },
      tools: { registry: toolRuntimeDefinitions },
      mcp,
      skills,
      rules
    },
    toolSchemas,
    toolDefinitions
  };
}

export function schemasForTools(tools: readonly ToolDefinition[]): ToolSchema[] {
  return tools.map((tool) => ({
    name: tool.declaration.name,
    description: tool.declaration.description,
    parameters: tool.declaration.parameters
  }));
}

export function recordsForTools(tools: readonly ToolDefinition[]): ToolDefinitionRecord[] {
  return tools.map((tool) => toolDefinitionRecord(tool));
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
    ...(snapshot.retryOnError !== undefined ? { retryOnError: snapshot.retryOnError } : {}),
    ...(snapshot.retryMaxAttempts !== undefined ? { retryMaxAttempts: snapshot.retryMaxAttempts } : {}),
    ...(snapshot.enableMultimodalTools !== undefined ? { enableMultimodalTools: snapshot.enableMultimodalTools } : {}),
    ...(snapshot.contextWindowTokens !== undefined ? { contextWindowTokens: snapshot.contextWindowTokens } : {}),
    ...(snapshot.generationConfig ? { generationConfig: snapshot.generationConfig } : {}),
    ...(snapshot.requestBody ? { requestBody: snapshot.requestBody } : {})
  };
}
