import * as vscode from 'vscode';
import type { ConversationLlmSettingsRecord, GlobalSettingsRecord, LlmInvocationSettingsSnapshotRecord, LlmProviderConfigRecord, ToolDefinitionRecord } from '../../shared/protocol';
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
import { createToolRegistry } from '../world/modules';
import type { ToolSchema } from '../world/modules/llm/contracts';
import { toolDefinitionRecord, type ToolDefinition } from '../world/modules/tools/registry';
import type { RuntimeEnv } from './RuntimeEnv';
import { McpRuntimeManager } from './mcpRuntimeManager';
import { applyModelSpecificConfig, applyRequestedModelOverride, modelExistsInConfig } from './llmSettingsResolution';

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
  const command = createCommandCapability({ paths: () => storage.isDataRootMutationActive?.() ? undefined : storage.paths });
  const workEnvironment = createWorkEnvironmentRuntimeCapability();
  const registry = createToolRegistry(command);
  const mcp = new McpRuntimeManager(storage);
  const llm = createLlmProviderCapability({
    settings: async (request) => {
      if (request && 'settingsSnapshot' in request && request.settingsSnapshot) return resolveSnapshotLlmProviderConfig(storage, request.settingsSnapshot, request.conversationId);
      const override = request?.model;
      const overrideConfig = override?.providerConfigId ? await storage.loadLlmProviderConfigById(override.providerConfigId) : undefined;
      const base = overrideConfig ?? await storage.loadActiveLlmProviderConfig(request?.conversationId);
      const requested = applyRequestedModelOverride(base, override, !!overrideConfig);
      // ChatSend / retry / edit 已显式携带本次选择的模型时，以请求值为权威。
      // 不能再用可能尚未落盘或迟到的 conversation override 把刚选择的模型覆盖回旧值。
      const withConversationModel = requested.applied
        ? requested.config
        : await applyConversationModelOverride(storage, request?.conversationId, requested.config);
      return applyModelSpecificConfig(withConversationModel);
    },
    compressionSettings: async (request) => {
      const activeProvider = await storage.loadActiveLlmProviderConfig(request.conversationId);
      const config = request.methodConfigId
        ? await storage.loadLlmCompressionConfigById(request.methodConfigId)
        : await storage.loadActiveLlmCompressionConfig(activeProvider.id, activeProvider.model);
      return config;
    },
    activeCompressionSettings: async (request) => {
      if (request?.providerConfigId) return storage.loadActiveLlmCompressionConfig(request.providerConfigId, request.model);
      const activeProvider = await storage.loadActiveLlmProviderConfig(request?.conversationId);
      return storage.loadActiveLlmCompressionConfig(activeProvider.id, activeProvider.model);
    },
    headers: { 'User-Agent': 'LimCode/0.0.1' },
    proxy: async () => createGlobalSettingsRecord(context).proxy || undefined,
    resolveAttachment: async (input) => {
      const result = await storage.resolveAttachmentForClient(input);
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

async function applyConversationModelOverride(
  storage: ReturnType<typeof createVsCodeStorageCapability>,
  conversationId: string | undefined,
  config: LlmProviderConfigRecord
): Promise<LlmProviderConfigRecord> {
  if (!conversationId) return config;
  const stored = await storage.loadConversationSettings(conversationId, 'llm');
  const settings = stored?.settings as ConversationLlmSettingsRecord | undefined;
  const model = settings?.modelOverrides?.[config.id]?.trim();
  if (!model || model === config.model || !modelExistsInConfig(config, model)) return config;
  return { ...config, model };
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
  const resolved: LlmProviderConfigRecord = {
    ...base,
    apiKey: storedConfig?.apiKey ?? (!snapshot.providerConfigId ? base.apiKey : ''),
    id: snapshot.providerConfigId ?? base.id,
    name: snapshot.providerConfigName ?? base.name,
    ...(snapshot.provider ? { provider: snapshot.provider } : {}),
    ...(snapshot.baseUrl ? { baseUrl: snapshot.baseUrl } : {}),
    model: modelId,
    models: modelId ? [{ id: modelId, name: modelName }, ...base.models.filter((model) => model.id !== modelId)] : base.models,
    ...(snapshot.toolCallFormat ? { toolCallFormat: snapshot.toolCallFormat } : {}),
    ...(snapshot.openaiResponsesTransport ? { openaiResponsesTransport: snapshot.openaiResponsesTransport } : {}),
    ...(snapshot.stream !== undefined ? { stream: snapshot.stream } : {}),
    ...(snapshot.retryOnError !== undefined ? { retryOnError: snapshot.retryOnError } : {}),
    ...(snapshot.retryMaxAttempts !== undefined ? { retryMaxAttempts: snapshot.retryMaxAttempts } : {}),
    ...(snapshot.enableMultimodalTools !== undefined ? { enableMultimodalTools: snapshot.enableMultimodalTools } : {})
  };

  if (snapshot.contextWindowTokens !== undefined) resolved.contextWindowTokens = snapshot.contextWindowTokens;
  else delete resolved.contextWindowTokens;
  if (snapshot.generationConfig !== undefined) resolved.generationConfig = snapshot.generationConfig;
  else delete resolved.generationConfig;
  if (snapshot.requestBody !== undefined) resolved.requestBody = snapshot.requestBody;
  else delete resolved.requestBody;
  if (snapshot.headers !== undefined) {
    const headers = storedConfig?.headers ?? (!snapshot.providerConfigId ? base.headers : undefined);
    if (headers) resolved.headers = headers;
    else delete resolved.headers;
  } else {
    delete resolved.headers;
  }
  return resolved;
}
