import { LlmEventType } from '../world/modules/llm/events';
import type {
  LlmCompactRequest,
  LlmCompactResult,
  LlmDryRunOptions,
  LlmDryRunResult,
  LlmResolveInvocationRequest,
  LlmStartRequest,
  ToolSchema
} from '../world/modules/llm/contracts';
import type { Emit, LlmCapability } from './types';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  DEFAULT_LLM_COMPRESSION_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_LLM_COMPRESSION_SUMMARY_USER_PROMPT,
  isInlineDataPart,
  DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
  DEFAULT_LLM_RETRY_ON_ERROR,
  isTextPart,
  isProviderContextPart
} from '../../shared/protocol';
import type {
  ContentPart,
  LlmCompressionConfigRecord,
  LlmGenerationConfigRecord,
  LlmInvocationSettingsSnapshotRecord,
  LlmProviderConfigRecord,
  LlmProviderHeadersRecord,
  LlmProviderKind,
  LlmProviderModelRecord,
  LlmToolCallFormat,
  LlmRawErrorInfoRecord,
  LlmUsageMetadataRecord,
  MessageContent
} from '../../shared/protocol';

export const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';

type MaybeProvider<T, TArg = void> = T | undefined | ((arg: TArg) => T | undefined | Promise<T | undefined>);
type LlmSettingsRequest = LlmStartRequest | LlmResolveInvocationRequest | undefined;
type LlmCompressionSettingsProvider = (request: LlmCompactRequest) => LlmCompressionConfigRecord | undefined | Promise<LlmCompressionConfigRecord | undefined>;

type UnifiedModule = typeof import('unified-llm-provider');
type UnifiedContent = import('unified-llm-provider').Content;
type UnifiedPart = import('unified-llm-provider').Part;
type UnifiedLLMRequest = import('unified-llm-provider').LLMRequest;
type UnifiedLLMResponse = import('unified-llm-provider').LLMResponse;
type UnifiedLLMCompactResponse = import('unified-llm-provider').LLMCompactResponse;
type UnifiedLLMStreamChunk = import('unified-llm-provider').LLMStreamChunk;
type UnifiedFunctionDeclaration = import('unified-llm-provider').FunctionDeclaration;
type UnifiedModelCatalogEntry = import('unified-llm-provider').ModelCatalogEntry;
type UndiciModule = typeof import('undici');

interface UnifiedDryRunResult {
  url: string;
  method: 'POST';
  stream: boolean;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
  curl: string;
  providerName: string;
  inputFormat: string;
  outputFormat: string;
  timestamp: number;
}

interface UnifiedDryRunCapable {
  dryRun(request: unknown, options?: { inputFormat?: string; outputFormat?: string; stream?: boolean; curl?: { includeApiKey?: boolean; prettyBody?: boolean } }): Promise<UnifiedDryRunResult>;
}

export interface LlmProviderOptions {
  settings: MaybeProvider<LlmProviderConfigRecord, LlmSettingsRequest>;
  compressionSettings?: LlmCompressionSettingsProvider;
  activeCompressionSettings?: (conversationId?: string) => LlmCompressionConfigRecord | undefined | Promise<LlmCompressionConfigRecord | undefined>;

  headers?: MaybeProvider<Record<string, string>>;
}
interface RetryControl {
  cancelRequested: boolean;
  wakeRetryWait?: () => void;
}

interface LlmAttemptFailure {
  message: string;
  rawError?: LlmRawErrorInfoRecord;
  createdAt?: number;
  streamOutputDurationMs?: number;
}

interface LlmAttemptTimingState {
  firstStreamChunkAt?: number;
  firstStreamChunkMark?: number;
  streamTimingChunkCount: number;
}

class LlmAttemptFailureError extends Error {
  public constructor(public readonly failure: LlmAttemptFailure) {
    super(failure.message);
    this.name = 'LlmAttemptFailureError';
  }
}



/**
 * LLM capability 只维护 unified/Gemini-like 请求。
 * provider 真实 wire format 交给 unified-llm-provider 的 provider/format registry 处理。
 */
export function createLlmProviderCapability(options: LlmProviderOptions): LlmCapability {
  const controllers = new Map<string, AbortController>();
  const retryControls = new Map<string, RetryControl>();
  const resolvedRuntimeSettingsByInvocationId = new Map<string, LlmProviderConfigRecord>();

  return {
    resolveInvocation(request, emit) {
      void resolveLlmInvocationProvider(request, emit, options, resolvedRuntimeSettingsByInvocationId);
    },
    start(request, emit) {
      controllers.get(request.id)?.abort(createAbortError(`Superseded LLM request: ${request.id}`));
      retryControls.get(request.id)?.wakeRetryWait?.();

      const controller = new AbortController();
      const retryControl: RetryControl = { cancelRequested: false };
      controllers.set(request.id, controller);
      retryControls.set(request.id, retryControl);

      void startLlmProvider(request, emit, options, controller.signal, resolvedRuntimeSettingsByInvocationId, retryControl)
        .finally(() => {
          if (controllers.get(request.id) === controller) {
            controllers.delete(request.id);
          }
          if (retryControls.get(request.id) === retryControl) retryControls.delete(request.id);
          if (request.invocationId) resolvedRuntimeSettingsByInvocationId.delete(request.invocationId);
        });
    },
    compact(request, emit) {
      controllers.get(request.id)?.abort(createAbortError(`Superseded LLM compact request: ${request.id}`));
      const controller = new AbortController();
      controllers.set(request.id, controller);
      void compactLlmProvider(request, emit, options, controller.signal)
        .finally(() => {
          if (controllers.get(request.id) === controller) controllers.delete(request.id);
        });
    },
    dryRun(request, dryRunOptions) {
      return dryRunLlmProvider(request, options, dryRunOptions, resolvedRuntimeSettingsByInvocationId);
    },
    listModels(config) {
      return listLlmProviderModels(config, options);
    },
    cancelRetry(requestId) {
      const control = retryControls.get(requestId);
      if (!control) return;
      control.cancelRequested = true;
      control.wakeRetryWait?.();
    },
    abort(requestId) {
      const control = retryControls.get(requestId);
      if (control) control.cancelRequested = true;
      control?.wakeRetryWait?.();
      const controller = controllers.get(requestId);
      if (!controller) return;
      controllers.delete(requestId);
      controller.abort(createAbortError(`Aborted LLM request: ${requestId}`));
    }
  };
}

export async function startLlmProvider(
  request: LlmStartRequest,
  emit: Emit,
  options: LlmProviderOptions,
  signal?: AbortSignal,
  resolvedRuntimeSettingsByInvocationId?: Map<string, LlmProviderConfigRecord>,
  retryControl: RetryControl = { cancelRequested: false }
): Promise<void> {
  try {
    const settings = await resolveRuntimeSettings(request, options, resolvedRuntimeSettingsByInvocationId);
    emitLlmStarted(emit, request.id, request.invocationId, resolveModelDisplayName(settings));

    const unified = await importUnifiedLlmProvider();
    const registry = unified.createBootstrapExtensionRegistry();
    const proxy = normalizeOptionalString(settings.proxy);
    const proxyFetch = proxy ? await createUndiciFetch() : undefined;
    const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
    if (proxy) console.log(`[LimCode] LLM proxy enabled: ${proxy} (fetch=undici)`);
    const provider = unified.createLLMFromConfig({
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      ...(settings.contextWindowTokens ? { contextWindow: settings.contextWindowTokens } : {}),
      ...(headers ? { headers } : {}),
      ...(settings.requestBody ? { requestBody: settings.requestBody } : {}),
      ...(proxy ? { proxy, fetch: proxyFetch } : {})
    }, registry.llmProviders);

    const retryEnabled = settings.retryOnError !== false;
    const maxRetries = normalizeRetryMaxAttempts(settings.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS;
    let retryCount = 0;
    let sawRetry = false;

    while (true) {
      try {
        await runLlmAttempt(request, emit, settings, provider, signal);
        if (sawRetry) {
          emitLlmRetryRecovered(emit, request.id, '自动重试成功。', retryCount, maxRetries);
        }
        return;
      } catch (error) {
        if (isAbortError(error)) return;
        const failure = failureFromCaughtError(error);
        const nextRetryCount = retryCount + 1;
        const canRetry = retryEnabled
          && !retryControl.cancelRequested
          && (maxRetries === -1 || nextRetryCount <= maxRetries);

        if (!canRetry) {
          if (retryControl.cancelRequested && retryCount > 0) {
            emitLlmRetryCancelled(emit, request.id, failure.message, retryCount, maxRetries, failure.rawError);
          }
          emitLlmError(emit, request.id, failure.message, failure.rawError, {
            retryAttempt: retryCount || undefined,
            retryMaxAttempts: retryEnabled ? maxRetries : 0,
            createdAt: failure.createdAt,
            streamOutputDurationMs: failure.streamOutputDurationMs
          });
          return;
        }

        sawRetry = true;
        retryCount = nextRetryCount;
        const retryDelayMs = retryDelayForAttempt(retryCount);
        emitLlmRetryScheduled(emit, request.id, failure.message, failure.rawError, retryCount, maxRetries, retryDelayMs);
        const shouldRetry = await waitForRetryDelay(retryDelayMs, retryControl, signal);
        if (!shouldRetry) {
          emitLlmRetryCancelled(emit, request.id, failure.message, retryCount, maxRetries, failure.rawError);
          emitLlmError(emit, request.id, failure.message, failure.rawError, {
            retryAttempt: retryCount,
            retryMaxAttempts: maxRetries,
            createdAt: failure.createdAt,
            streamOutputDurationMs: failure.streamOutputDurationMs
          });
          return;
        }
        emitLlmRetryStarted(emit, request.id, failure.message, failure.rawError, retryCount, maxRetries);
      }
    }
  } catch (error) {
    if (isAbortError(error)) return;
    const failure = failureFromCaughtError(error);
    emitLlmError(emit, request.id, failure.message, failure.rawError, {
      createdAt: failure.createdAt,
      streamOutputDurationMs: failure.streamOutputDurationMs
    });
  }
}

async function runLlmAttempt(
  request: LlmStartRequest,
  emit: Emit,
  settings: LlmProviderConfigRecord,
  provider: {
    chat<T>(request: unknown, options: { inputFormat: 'unified'; outputFormat: 'unified'; signal?: AbortSignal }): Promise<T>;
    chatStream<T>(request: unknown, options: { inputFormat: 'unified'; outputFormat: 'unified'; signal?: AbortSignal }): AsyncIterable<T>;
  },
  signal?: AbortSignal
): Promise<void> {
  if (settings.stream === false) {
    const response = await provider.chat<UnifiedLLMResponse>(toUnifiedRequest(request, settings.generationConfig), {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal
    });
    if (hasUnifiedError(response)) {
      throw new LlmAttemptFailureError(failureFromProviderError(response.error, { rawResponse: response.rawResponse }));
    }
    emitUnifiedResponse(request.id, response, emit);
    emit({
      type: LlmEventType.Done,
      payload: { requestId: request.id, createdAt: Date.now(), ...(usageMetadataFromCompact(response.usageMetadata) ? { usageMetadata: usageMetadataFromCompact(response.usageMetadata) } : {}) }
    });
    return;
  }

  let latestUsageMetadata: LlmUsageMetadataRecord | undefined;
  const timing: LlmAttemptTimingState = { streamTimingChunkCount: 0 };
  let activeThoughtBlock: ActiveThoughtBlock | undefined;
  try {
    for await (const chunk of provider.chatStream<UnifiedLLMStreamChunk>(toUnifiedRequest(request, settings.generationConfig), {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal
    })) {
      if (hasUnifiedError(chunk)) {
        const failure = failureFromProviderError(chunk.error, {
          rawChunk: (chunk as { rawChunk?: unknown }).rawChunk ?? chunk,
          ...createDoneTiming(timing.firstStreamChunkAt, Date.now(), timing.firstStreamChunkMark, nowMonotonicMs(), timing.streamTimingChunkCount)
        });
        throw new LlmAttemptFailureError(failure);
      }
      const chunkAt = Date.now();
      const chunkMark = nowMonotonicMs();
      activeThoughtBlock = emitThoughtDeltas(request.id, activeThoughtBlock, chunk, chunkAt, emit);
      if (activeThoughtBlock && shouldCloseThoughtBlock(chunk)) activeThoughtBlock = finishThoughtBlock(request.id, activeThoughtBlock, chunkAt, emit);
      const chunkUsageMetadata = usageMetadataFromChunk(chunk);
      if (chunkUsageMetadata) latestUsageMetadata = mergeUsageMetadata(latestUsageMetadata, chunkUsageMetadata);
      if (hasStreamTimingChunk(chunk)) {
        timing.firstStreamChunkAt ??= chunkAt;
        timing.firstStreamChunkMark ??= chunkMark;
        timing.streamTimingChunkCount += 1;
      }
      emitUnifiedChunk(request.id, chunk, emit);
    }
  } catch (error) {
    if (activeThoughtBlock) finishThoughtBlock(request.id, activeThoughtBlock, Date.now(), emit);
    throw error;
  }

  const finishedAt = Date.now();
  const finishedMark = nowMonotonicMs();
  if (activeThoughtBlock) finishThoughtBlock(request.id, activeThoughtBlock, finishedAt, emit);
  emit({
    type: LlmEventType.Done,
    payload: { requestId: request.id, ...createDoneTiming(timing.firstStreamChunkAt, finishedAt, timing.firstStreamChunkMark, finishedMark, timing.streamTimingChunkCount), ...(latestUsageMetadata ? { usageMetadata: latestUsageMetadata } : {}) }
  });
}

function hasUnifiedError(value: unknown): value is { error: unknown; rawResponse?: unknown; rawChunk?: unknown } {
  return isRecord(value) && value.error !== undefined && value.error !== null;
}

function failureFromCaughtError(error: unknown): LlmAttemptFailure {
  if (error instanceof LlmAttemptFailureError) return error.failure;
  const rawError = rawErrorFromUnknown(error);
  return { message: messageFromRawError(rawError), rawError, createdAt: Date.now() };
}

function failureFromProviderError(error: unknown, extras: Record<string, unknown> = {}): LlmAttemptFailure {
  const rawError = rawErrorFromUnknown(error, extras);
  return {
    message: messageFromRawError(rawError),
    rawError,
    createdAt: typeof extras.createdAt === 'number' ? extras.createdAt : Date.now(),
    ...(typeof extras.streamOutputDurationMs === 'number' ? { streamOutputDurationMs: extras.streamOutputDurationMs } : {})
  };
}

function rawErrorFromUnknown(error: unknown, extras: Record<string, unknown> = {}): LlmRawErrorInfoRecord {
  const base = toPlainJsonLike(error);
  const baseRecord = isRecord(base) ? base : { data: base };
  const merged: LlmRawErrorInfoRecord = { ...baseRecord };
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) merged[key] = toPlainJsonLike(value);
  }
  if (typeof merged.message !== 'string') {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
    if (message) merged.message = message;
  }
  return merged;
}

function messageFromRawError(rawError: LlmRawErrorInfoRecord): string {
  if (typeof rawError.message === 'string' && rawError.message.trim()) return rawError.message.trim();
  const bodyMessage = nestedMessage(rawError.rawBody) ?? nestedMessage(rawError.rawResponse) ?? nestedMessage(rawError.data);
  if (bodyMessage) return bodyMessage;
  if (typeof rawError.bodyText === 'string' && rawError.bodyText.trim()) return truncateForSummary(rawError.bodyText.trim());
  if (typeof rawError.data === 'string' && rawError.data.trim()) return truncateForSummary(rawError.data.trim());
  const kind = typeof rawError.kind === 'string' && rawError.kind.trim() ? rawError.kind.trim() : 'llm_error';
  const status = typeof rawError.status === 'number' ? ` HTTP ${rawError.status}` : '';
  return `LLM 请求失败：${kind}${status}`;
}

function nestedMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value.message;
  if (typeof direct === 'string' && direct.trim()) return truncateForSummary(direct.trim());
  const error = value.error;
  if (isRecord(error)) {
    const message = error.message;
    if (typeof message === 'string' && message.trim()) return truncateForSummary(message.trim());
  }
  return undefined;
}

function truncateForSummary(value: string): string {
  const limit = 600;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function retryDelayForAttempt(retryAttempt: number): number {
  const base = 1000 * (2 ** Math.max(0, retryAttempt - 1));
  return Math.min(10_000, base);
}

function waitForRetryDelay(delayMs: number, control: RetryControl, signal?: AbortSignal): Promise<boolean> {
  if (control.cancelRequested) return Promise.resolve(false);
  if (signal?.aborted) return Promise.reject(createAbortError('Aborted LLM retry wait.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const previousWake = control.wakeRetryWait;
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
      control.wakeRetryWait = previousWake;
    };
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError('Aborted LLM retry wait.'));
    };
    control.wakeRetryWait = () => {
      previousWake?.();
      settle(false);
    };
    timeout = setTimeout(() => settle(!control.cancelRequested), delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toPlainJsonLike(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const cause = (value as { cause?: unknown }).cause;
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(cause !== undefined ? { cause: toPlainJsonLike(cause, seen) } : {})
    };
  }
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    return Object.fromEntries(value.entries());
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toPlainJsonLike(item, seen));
  if (typeof (value as { entries?: unknown }).entries === 'function' && typeof (value as { forEach?: unknown }).forEach === 'function') {
    try {
      return Object.fromEntries((value as { entries(): Iterable<[string, unknown]> }).entries());
    } catch {
      // fall through
    }
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = toPlainJsonLike(child, seen);
  }
  return result;
}




export async function resolveLlmInvocationProvider(
  request: LlmResolveInvocationRequest,
  emit: Emit,
  options: LlmProviderOptions,
  resolvedRuntimeSettingsByInvocationId?: Map<string, LlmProviderConfigRecord>
): Promise<void> {
  try {
    const settings = normalizeSettings(await resolveMaybe(options.settings, request));
    const compressionConfig = await options.activeCompressionSettings?.(request.conversationId);
    resolvedRuntimeSettingsByInvocationId?.set(request.invocationId, settings);
    emit({ type: LlmEventType.InvocationResolved, payload: { invocationId: request.invocationId, requestId: request.requestId, settings: snapshotFromSettings(settings, compressionConfig), resolvedAt: Date.now() } });
  } catch (error) {
    emit({ type: LlmEventType.InvocationResolveError, payload: { invocationId: request.invocationId, requestId: request.requestId, message: error instanceof Error ? error.message : String(error), resolvedAt: Date.now() } });
  }
}

export async function dryRunLlmProvider(request: LlmStartRequest, options: LlmProviderOptions, dryRunOptions: LlmDryRunOptions = {}, resolvedRuntimeSettingsByInvocationId?: Map<string, LlmProviderConfigRecord>): Promise<LlmDryRunResult> {
  const settings = await resolveRuntimeSettings(request, options, resolvedRuntimeSettingsByInvocationId);
  const apiKeyAvailable = !!settings.apiKey;
  const runtimeSettings = apiKeyAvailable ? settings : { ...settings, apiKey: 'limcode-dry-run-placeholder-key' };

  const unified = await importUnifiedLlmProvider();
  const registry = unified.createBootstrapExtensionRegistry();
  const proxy = normalizeOptionalString(runtimeSettings.proxy);
  const headers = mergeHeaders(await resolveMaybe(options.headers), runtimeSettings.headers);
  const provider = unified.createLLMFromConfig({
    provider: runtimeSettings.provider,
    model: runtimeSettings.model,
    apiKey: runtimeSettings.apiKey,
    baseUrl: runtimeSettings.baseUrl,
    ...(runtimeSettings.contextWindowTokens ? { contextWindow: runtimeSettings.contextWindowTokens } : {}),
    ...(headers ? { headers } : {}),
    ...(runtimeSettings.requestBody ? { requestBody: runtimeSettings.requestBody } : {}),
    ...(proxy ? { proxy } : {})
  }, registry.llmProviders);

  const dryRun = (provider as unknown as Partial<UnifiedDryRunCapable>).dryRun;
  if (typeof dryRun !== 'function') {
    throw new Error('当前 unified-llm-provider 版本不支持 provider.dryRun，请更新依赖。');
  }

  const result = await dryRun.call(provider, toUnifiedRequest(request, runtimeSettings.generationConfig), {
    inputFormat: 'unified',
    outputFormat: 'unified',
    stream: runtimeSettings.stream !== false,
    curl: { includeApiKey: dryRunOptions.includeApiKey === true, prettyBody: true }
  });

  return {
    provider: runtimeSettings.provider,
    model: runtimeSettings.model,
    providerName: result.providerName,
    url: result.url,
    method: result.method,
    stream: result.stream,
    headers: result.headers,
    body: result.body,
    bodyText: result.bodyText,
    curl: result.curl,
    maskedCurl: unified.formatRequestAsCurl(result.url, result.headers, result.body, { includeApiKey: false, prettyBody: true }),
    inputFormat: result.inputFormat,
    outputFormat: result.outputFormat,
    generatedAt: result.timestamp,
    maskedSecrets: dryRunOptions.includeApiKey !== true || !apiKeyAvailable,
    apiKeyAvailable
  };
}

export async function listLlmProviderModels(config: LlmProviderConfigRecord, options: LlmProviderOptions): Promise<LlmProviderModelRecord[]> {
  const settings = normalizeSettings(config);

  const unified = await importUnifiedLlmProvider();
  const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
  const result = await unified.listAvailableModels({
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    ...(headers ? { headers } : {}),
    outputFormat: 'unified'
  });

  return result.models.map(modelCatalogEntryToRecord);
}

export type LlmCompressionMethodHandler = (
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal
) => Promise<LlmCompactResult>;

const compressionMethodHandlers = new Map<LlmCompressionConfigRecord['kind'], LlmCompressionMethodHandler>();

export function registerLlmCompressionMethod(kind: LlmCompressionConfigRecord['kind'], handler: LlmCompressionMethodHandler): void {
  compressionMethodHandlers.set(kind, handler);
}

function ensureDefaultCompressionMethodsRegistered(): void {
  if (compressionMethodHandlers.size > 0) return;
  registerLlmCompressionMethod('openai_responses_compact', compactWithOpenAIResponses);
  registerLlmCompressionMethod('llm_summary', compactWithSummary);
  registerLlmCompressionMethod('deterministic_summary', compactWithSummary);
  registerLlmCompressionMethod('manual_summary', compactWithSummary);
}

export async function compactLlmProvider(request: LlmCompactRequest, emit: Emit, options: LlmProviderOptions, signal?: AbortSignal): Promise<void> {
  try {
    ensureDefaultCompressionMethodsRegistered();
    const methodConfig = normalizeCompressionConfig(await options.compressionSettings?.(request), request.methodKind);
    if (methodConfig.kind === 'disabled') {
      throw new Error('当前压缩方法已关闭。');
    }

    const handler = compressionMethodHandlers.get(methodConfig.kind);
    if (!handler) throw new Error(`未注册的压缩方法：${methodConfig.kind}`);
    const result = await handler(request, methodConfig, options, signal);

    emit({
      type: LlmEventType.CompactDone,
      payload: {
        requestId: request.id,
        blockId: request.blockId,
        conversationId: request.conversationId,
        result,
        completedAt: Date.now()
      }
    });
  } catch (error) {
    if (isAbortError(error)) return;
    emit({
      type: LlmEventType.CompactError,
      payload: {
        requestId: request.id,
        blockId: request.blockId,
        conversationId: request.conversationId,
        message: error instanceof Error ? error.message : String(error),
        completedAt: Date.now()
      }
    });
  }
}

async function compactWithOpenAIResponses(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal
): Promise<LlmCompactResult> {
  const modelOverride = methodConfig.openaiResponsesCompact?.model?.trim();
  const providerConfigId = methodConfig.openaiResponsesCompact?.providerConfigId?.trim();
  const settings = await resolveRuntimeSettings({
    id: request.id,
    contents: request.contents,
    tools: [],
    conversationId: request.conversationId,
    model: {
      ...(providerConfigId ? { providerConfigId } : {}),
      model: modelOverride || ''
    }
  }, options);

  if (settings.provider !== 'openai-responses') {
    throw new Error('OpenAI 原生压缩仅支持 openai-responses 渠道格式。');
  }
  if (!settings.apiKey) {
    throw new Error('缺少 LLM API Key。请在全局设置的“渠道”页签里填写并保存。');
  }

  const unified = await importUnifiedLlmProvider();
  const registry = unified.createBootstrapExtensionRegistry();
  const proxy = normalizeOptionalString(settings.proxy);
  const proxyFetch = proxy ? await createUndiciFetch() : undefined;
  const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
  const provider = unified.createLLMFromConfig({
    provider: settings.provider,
    model: settings.model,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    ...(settings.contextWindowTokens ? { contextWindow: settings.contextWindowTokens } : {}),
    ...(headers ? { headers } : {}),
    ...(settings.requestBody ? { requestBody: settings.requestBody } : {}),
    ...(proxy ? { proxy, fetch: proxyFetch } : {})
  }, registry.llmProviders) as unknown as { compact?: (request: unknown, options?: unknown) => Promise<UnifiedLLMCompactResponse> };

  if (typeof provider.compact !== 'function') {
    throw new Error('当前 unified-llm-provider 不支持 provider.compact。');
  }

  const compacted = await provider.compact(
    { contents: request.contents.map(toUnifiedContent) },
    { inputFormat: 'unified', outputFormat: 'unified', signal }
  );

  return {
    id: compacted.id,
    object: compacted.object,
    createdAt: compacted.createdAt,
    contents: (compacted.contents ?? []).map(fromUnifiedContent),
    usageMetadata: usageMetadataFromCompact(compacted.usageMetadata),
    settingsSnapshot: snapshotFromSettings(settings, methodConfig),
    rawResponse: compacted.rawResponse,
    methodConfig
  };
}

async function compactWithSummary(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal
): Promise<LlmCompactResult> {
  const summary = await generateSummaryText(request, methodConfig, options, signal);
  const contents: MessageContent[] = [{ role: 'user', parts: [{ text: `[Context Summary]\n\n${summary.text}` }] }];
  return {
    id: `summary-${request.blockId}`,
    object: 'limcode.context_summary',
    createdAt: Date.now(),
    contents,
    ...(summary.settings ? { settingsSnapshot: snapshotFromSettings(summary.settings, methodConfig) } : {}),
    methodConfig
  };
}

interface GeneratedSummaryTextResult { text: string; settings?: LlmProviderConfigRecord }

async function generateSummaryText(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal
): Promise<GeneratedSummaryTextResult> {
  if (methodConfig.kind === 'deterministic_summary' || methodConfig.kind === 'manual_summary') {
    return { text: deterministicSummary(request.contents) };
  }

  const summarySettings = methodConfig.llmSummary;
  const providerConfigId = summarySettings?.providerConfigId?.trim();
  const model = summarySettings?.model?.trim();
  const settings = await resolveRuntimeSettings({
    id: request.id,
    contents: request.contents,
    tools: [],
    conversationId: request.conversationId,
    ...(providerConfigId || model ? { model: { ...(providerConfigId ? { providerConfigId } : {}), model: model || '' } } : {})
  }, options);

  if (!settings.apiKey) return { text: deterministicSummary(request.contents), settings };

  const unified = await importUnifiedLlmProvider();
  const registry = unified.createBootstrapExtensionRegistry();
  const proxy = normalizeOptionalString(settings.proxy);
  const proxyFetch = proxy ? await createUndiciFetch() : undefined;
  const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
  const provider = unified.createLLMFromConfig({
    provider: settings.provider,
    model: settings.model,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    ...(settings.contextWindowTokens ? { contextWindow: settings.contextWindowTokens } : {}),
    ...(headers ? { headers } : {}),
    ...(settings.requestBody ? { requestBody: settings.requestBody } : {}),
    ...(proxy ? { proxy, fetch: proxyFetch } : {})
  }, registry.llmProviders);

  const systemPrompt = summarySettings?.systemPrompt?.trim() || DEFAULT_LLM_COMPRESSION_SUMMARY_SYSTEM_PROMPT;
  const userPrompt = summarySettings?.userPrompt?.trim() || DEFAULT_LLM_COMPRESSION_SUMMARY_USER_PROMPT;
  const transcript = renderContentsForSummary(request.contents);
  const summaryRequest = {
    contents: [{ role: 'user', parts: [{ text: `${userPrompt}\n\n${transcript}` }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: summarySettings?.generationConfig ?? settings.generationConfig
  };

  if (settings.stream !== false) {
    let text = '';
    for await (const chunk of provider.chatStream<UnifiedLLMStreamChunk>(summaryRequest, { inputFormat: 'unified', outputFormat: 'unified', signal })) {
      text += chunk.textDelta ?? visibleTextFromParts(chunk.partsDelta ?? []);
    }
    return { text: text.trim() || deterministicSummary(request.contents), settings };
  }

  const response = await provider.chat<UnifiedLLMResponse>(summaryRequest, { inputFormat: 'unified', outputFormat: 'unified', signal });

  const text = visibleTextFromParts(response.content?.parts ?? []).trim();
  return { text: text || deterministicSummary(request.contents), settings };
}

function normalizeCompressionConfig(input: LlmCompressionConfigRecord | undefined, fallbackKind?: LlmCompressionConfigRecord['kind']): LlmCompressionConfigRecord {
  const now = Date.now();
  const kind = input?.kind ?? fallbackKind ?? 'llm_summary';
  return {
    id: input?.id ?? 'inline-compression-config',
    name: input?.name ?? '临时压缩方法',
    kind,
    trigger: input?.trigger ?? { mode: 'manual', preserveLatestMessages: 8 },
    ...(input?.openaiResponsesCompact ? { openaiResponsesCompact: input.openaiResponsesCompact } : {}),
    ...(input?.llmSummary ? { llmSummary: input.llmSummary } : {}),
    fallbackPolicy: input?.fallbackPolicy ?? { whenNativeUnavailable: 'use_summary' },
    createdAt: input?.createdAt ?? now,
    updatedAt: input?.updatedAt ?? now
  };
}

function fromUnifiedContent(content: UnifiedContent): MessageContent {
  return {
    role: content.role === 'model' ? 'model' : 'user',
    parts: (content.parts ?? []).map(fromUnifiedPart).filter((part): part is ContentPart => part !== undefined)
  };
}

function fromUnifiedPart(part: UnifiedPart): ContentPart | undefined {
  const record = part as Record<string, unknown>;
  if (isRecord(record.providerContext)) return { providerContext: record.providerContext as never };
  if (typeof record.text === 'string' || typeof record.thought === 'boolean' || typeof record.thoughtSignature === 'string') {
    return {
      text: typeof record.text === 'string' ? record.text : '',
      ...(typeof record.thought === 'boolean' ? { thought: record.thought } : {}),
      ...(typeof record.thoughtSignature === 'string' ? { thoughtSignature: record.thoughtSignature } : {}),
      ...(typeof record.thoughtDurationMs === 'number' ? { thoughtDurationMs: record.thoughtDurationMs } : {})
    };
  }
  const call = record.functionCall;
  if (isRecord(call) && typeof call.name === 'string') {
    return { id: typeof call.callId === 'string' ? call.callId : undefined, functionCall: { name: call.name, args: call.args ?? {} } };
  }
  const response = record.functionResponse;
  if (isRecord(response) && typeof response.name === 'string') {
    return { id: typeof response.callId === 'string' ? response.callId : undefined, functionResponse: { name: response.name, response: response.response ?? {} } };
  }
  const inlineData = record.inlineData;
  if (isRecord(inlineData) && typeof inlineData.mimeType === 'string' && typeof inlineData.data === 'string') {
    return { inlineData: { mimeType: inlineData.mimeType, data: inlineData.data } };
  }
  return undefined;
}

function usageMetadataFromCompact(value: unknown): LlmUsageMetadataRecord | undefined {
  const cleaned = stripUndefined(value);
  return isRecord(cleaned) && Object.keys(cleaned).length > 0 ? cleaned as LlmUsageMetadataRecord : undefined;
}

function renderContentsForSummary(contents: MessageContent[]): string {
  return contents.map((content, index) => `${index + 1}. ${content.role}: ${content.parts.map(renderSummaryPart).filter(Boolean).join('\n') || '[empty]'}`).join('\n\n');
}

function renderSummaryPart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[tool call] ${part.functionCall.name}: ${stringifyJson(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[tool result] ${part.functionResponse.name}: ${stringifyJson(part.functionResponse.response)}`;
  if (isInlineDataPart(part)) return `[inline data] ${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `[file] ${part.fileData.uri}`;
  if (isProviderContextPart(part)) return `[provider context] ${part.providerContext.format}:${part.providerContext.itemType ?? 'context'}`;
  return '';
}

function deterministicSummary(contents: MessageContent[]): string {
  const rendered = renderContentsForSummary(contents).trim();
  if (!rendered) return '暂无可压缩的上下文。';
  const limit = 12_000;
  return rendered.length > limit ? `${rendered.slice(0, limit)}\n\n[已截断]` : rendered;
}

function modelCatalogEntryToRecord(model: UnifiedModelCatalogEntry): LlmProviderModelRecord {
  return {
    id: model.id,
    name: model.displayName || model.label || model.name || model.id,
    ...(model.createdAt ? { createdAt: model.createdAt } : {})
  };
}

function normalizeSettings(settings: LlmProviderConfigRecord | undefined): LlmProviderConfigRecord {
  const proxy = normalizeOptionalString(settings?.proxy);
  const headers = normalizeHeaders(settings?.headers);
  const generationConfig = settings?.generationConfig;
  const requestBody = settings?.requestBody;
  const contextWindowTokens = normalizeContextWindowTokens(settings?.contextWindowTokens);
  const retryMaxAttempts = normalizeRetryMaxAttempts(settings?.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS;
  return {
    id: settings?.id?.trim() || 'llm-provider-config-default',
    name: settings?.name?.trim() || '默认渠道',
    provider: normalizeProvider(settings?.provider),
    baseUrl: settings?.baseUrl?.trim() || DEFAULT_LLM_BASE_URL,
    model: settings?.model?.trim() ?? '',
    models: settings?.models ?? [],
    apiKey: settings?.apiKey?.trim() ?? '',
    toolCallFormat: normalizeToolCallFormat(settings?.toolCallFormat),
    stream: settings?.stream !== false,
    retryOnError: settings?.retryOnError !== false ? DEFAULT_LLM_RETRY_ON_ERROR : false,
    retryMaxAttempts,
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(proxy ? { proxy } : {}),
    ...(headers ? { headers } : {}),
    ...(nonEmptyRecord(generationConfig) ? { generationConfig } : {}),
    ...(nonEmptyRecord(requestBody) ? { requestBody } : {}),
    createdAt: settings?.createdAt ?? 0,
    updatedAt: settings?.updatedAt ?? 0
  };
}

async function resolveRuntimeSettings(
  request: LlmStartRequest,
  options: LlmProviderOptions,
  resolvedRuntimeSettingsByInvocationId?: Map<string, LlmProviderConfigRecord>
): Promise<LlmProviderConfigRecord> {
  const cached = request.invocationId ? resolvedRuntimeSettingsByInvocationId?.get(request.invocationId) : undefined;
  if (cached) return normalizeSettings(cached);
  return normalizeSettings(await resolveMaybe(options.settings, request));
}

function snapshotFromSettings(settings: LlmProviderConfigRecord, compressionConfig?: LlmCompressionConfigRecord): LlmInvocationSettingsSnapshotRecord {
  const modelId = settings.model.trim();
  const modelName = modelId ? settings.models.find((model) => model.id === modelId)?.name.trim() || modelId : undefined;
  return {
    providerConfigId: settings.id,
    providerConfigName: settings.name,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    ...(modelId ? { modelId } : {}),
    ...(modelName ? { modelName, displayModelName: modelName } : {}),
    toolCallFormat: settings.toolCallFormat,
    stream: settings.stream !== false,
    retryOnError: settings.retryOnError !== false,
    retryMaxAttempts: normalizeRetryMaxAttempts(settings.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    ...(settings.contextWindowTokens ? { contextWindowTokens: settings.contextWindowTokens } : {}),
    ...(settings.generationConfig ? { generationConfig: settings.generationConfig } : {}),
    ...(settings.requestBody ? { requestBody: settings.requestBody } : {}),
    ...(compressionConfig?.id ? { compressionConfigId: compressionConfig.id } : {}),
    ...(compressionConfig?.kind ? { compressionMethodKind: compressionConfig.kind } : {}),
    ...(compressionConfig?.trigger ? { compressionTrigger: compressionConfig.trigger } : {}),
    ...(settings.headers ? { headers: maskSensitiveHeaders(settings.headers) } : {})
  };
}

function resolveModelDisplayName(settings: LlmProviderConfigRecord): string | undefined {
  const modelId = settings.model.trim();
  if (!modelId) return undefined;
  const catalogName = settings.models.find((model) => model.id === modelId)?.name.trim();
  return catalogName || modelId;
}

function maskSensitiveHeaders(headers: LlmProviderHeadersRecord): LlmProviderHeadersRecord {
  const masked: LlmProviderHeadersRecord = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = isSensitiveHeaderName(key) ? maskSecretValue(value) : value;
  }
  return masked;
}

function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'authorization' || normalized === 'x-api-key' || normalized === 'x-goog-api-key' || normalized === 'api-key' || normalized === 'openai-key' || normalized.includes('token') || normalized.includes('secret') || normalized.includes('key');
}

function maskSecretValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= 8 ? '••••••••' : `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

function normalizeProvider(provider: LlmProviderKind | undefined): LlmProviderKind {
  return provider === 'gemini' || provider === 'claude' || provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'deepseek'
    ? provider
    : 'openai-compatible';
}

function normalizeToolCallFormat(format: LlmToolCallFormat | undefined): LlmToolCallFormat {
  return format === 'function-call' ? format : 'function-call';
}

function normalizeHeaders(headers: unknown): LlmProviderHeadersRecord | undefined {
  if (!isRecord(headers)) return undefined;
  const result: LlmProviderHeadersRecord = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue;
    result[key] = String(rawValue).trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeHeaders(...records: Array<Record<string, string> | undefined>): LlmProviderHeadersRecord | undefined {
  const result: LlmProviderHeadersRecord = {};
  for (const record of records) {
    if (!record) continue;
    for (const [rawKey, rawValue] of Object.entries(record)) {
      const key = rawKey.trim();
      if (!key) continue;
      const existingKey = Object.keys(result).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      if (existingKey && existingKey !== key) delete result[existingKey];
      result[key] = rawValue;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeContextWindowTokens(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function normalizeRetryMaxAttempts(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const attempts = Math.floor(number);
  return attempts < -1 ? -1 : attempts;
}

function nonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function toUnifiedRequest(request: LlmStartRequest, generationConfig?: LlmGenerationConfigRecord): UnifiedLLMRequest {
  return {
    contents: request.contents.map(toUnifiedContent),
    ...(request.systemInstruction ? { systemInstruction: { parts: request.systemInstruction.parts.map(toUnifiedPart) } } : {}),
    ...(request.tools.length === 0 ? {} : { tools: [{ functionDeclarations: request.tools.map(toUnifiedFunctionDeclaration) }] }),
    ...(nonEmptyRecord(generationConfig) ? { generationConfig } : {})
  };
}

function toUnifiedContent(content: MessageContent): UnifiedContent {
  return {
    role: content.role === 'model' ? 'model' : 'user',
    parts: content.parts.map(toUnifiedPart)
  };
}

function toUnifiedPart(part: ContentPart): UnifiedPart {
  if (isTextPart(part)) {
    return {
      text: part.text,
      ...(part.thought !== undefined ? { thought: part.thought } : {}),
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
    };
  }
  if (isFunctionCallPart(part)) {
    return {
      functionCall: { name: part.functionCall.name, args: asRecord(part.functionCall.args), ...(part.id ? { callId: part.id } : {}) },
      // Gemini 会校验带工具调用的 thoughtSignature；作为 part 同层级字段透传给 provider。
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
    };
  }
  if (isFunctionResponsePart(part)) {
    return {
      functionResponse: { name: part.functionResponse.name, response: asRecord(part.functionResponse.response), ...(part.id ? { callId: part.id } : {}) }
    };
  }
  if (isInlineDataPart(part)) return { inlineData: { mimeType: part.inlineData.mimeType, data: part.inlineData.data } };
  if (isFileDataPart(part)) {
    // unified-llm-provider 当前统一 Part 没有 fileData；先作为文本占位保留语义。
    return { text: `[fileData:${part.fileData.mimeType ?? 'unknown'}:${part.fileData.uri}]` };
  }
  if (isProviderContextPart(part)) return { providerContext: part.providerContext } as unknown as UnifiedPart;
  return assertNever(part);
}

function toUnifiedFunctionDeclaration(tool: ToolSchema): UnifiedFunctionDeclaration {
  const parameters = isFunctionParameters(tool.parameters)
    ? tool.parameters
    : { type: 'object' as const, properties: {} };
  return {
    name: tool.name,
    description: tool.description,
    parameters
  };
}

function emitUnifiedChunk(requestId: string, chunk: UnifiedLLMStreamChunk, emit: Emit): void {
  const text = chunk.textDelta ?? visibleTextFromParts(chunk.partsDelta ?? []);
  if (text) emit({ type: LlmEventType.Delta, payload: { requestId, text } });

  const calls = [
    ...(chunk.functionCalls ?? []),
    ...(chunk.partsDelta ?? []).filter(isUnifiedFunctionCallPart)
  ].map((part, index) => {
    const thoughtSignature = thoughtSignatureFromPart(part);
    return {
      id: part.functionCall.callId ?? `tool_call_${index}`,
      name: part.functionCall.name,
      argsJson: stringifyJson(part.functionCall.args ?? {}),
      ...(thoughtSignature ? { thoughtSignature } : {})
    };
  });

  if (calls.length > 0) {
    emit({ type: LlmEventType.ToolCall, payload: { requestId, calls } });
  }
}

function emitUnifiedResponse(requestId: string, response: UnifiedLLMResponse, emit: Emit): void {
  const parts = response.content?.parts ?? [];
  const visibleText = visibleTextFromParts(parts);
  if (visibleText) emit({ type: LlmEventType.Delta, payload: { requestId, text: visibleText } });

  const thoughtParts = parts.filter((part) => 'text' in part && (part as { thought?: unknown }).thought === true);
  for (const part of thoughtParts) {
    const text = typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '';
    const signature = thoughtSignatureFromPart(part);
    if (text) emit({ type: LlmEventType.ThoughtDelta, payload: { requestId, text, ...(signature ? { thoughtSignature: signature } : {}) } });
    emit({ type: LlmEventType.ThoughtDone, payload: { requestId, thoughtDurationMs: 0, ...(signature ? { thoughtSignature: signature } : {}) } });
  }

  const calls = parts.filter(isUnifiedFunctionCallPart).map((part, index) => {
    const thoughtSignature = thoughtSignatureFromPart(part);
    return {
      id: part.functionCall.callId ?? `tool_call_${index}`,
      name: part.functionCall.name,
      argsJson: stringifyJson(part.functionCall.args ?? {}),
      ...(thoughtSignature ? { thoughtSignature } : {})
    };
  });
  if (calls.length > 0) emit({ type: LlmEventType.ToolCall, payload: { requestId, calls } });
}



interface LlmDoneTiming {
  createdAt: number;
  streamOutputDurationMs?: number;
}

function createDoneTiming(
  firstChunkAt: number | undefined,
  finishedAt = Date.now(),
  firstChunkMark?: number,
  finishedMark?: number,
  streamChunkCount = 0
): LlmDoneTiming {
  const rawDurationMs = firstChunkAt === undefined
    ? undefined
    : firstChunkMark !== undefined && finishedMark !== undefined
      ? finishedMark - firstChunkMark
      : finishedAt - firstChunkAt;

  const streamOutputDurationMs = streamChunkCount >= 3 && rawDurationMs !== undefined && rawDurationMs >= 2
    ? Math.round(rawDurationMs)
    : undefined;

  return {
    createdAt: firstChunkAt ?? finishedAt,
    ...(streamOutputDurationMs !== undefined ? { streamOutputDurationMs } : {})
  };
}

function nowMonotonicMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function usageMetadataFromChunk(chunk: UnifiedLLMStreamChunk): LlmUsageMetadataRecord | undefined {
  const cleaned = stripUndefined(chunk.usageMetadata);
  return isRecord(cleaned) && Object.keys(cleaned).length > 0
    ? cleaned as LlmUsageMetadataRecord
    : undefined;
}

function mergeUsageMetadata(
  previous: LlmUsageMetadataRecord | undefined,
  next: LlmUsageMetadataRecord
): LlmUsageMetadataRecord {
  if (!previous) return next;
  return { ...previous, ...next };
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    result[key] = stripUndefined(child);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasStreamTimingChunk(chunk: UnifiedLLMStreamChunk): boolean {
  return hasStreamOutput(chunk) || hasThoughtOutput(chunk);
}

function hasThoughtOutput(chunk: UnifiedLLMStreamChunk): boolean {
  return (chunk.partsDelta ?? []).some((part) => isUnifiedThoughtTextPart(part) && !!part.text);
}

function hasStreamOutput(chunk: UnifiedLLMStreamChunk): boolean {
  if (chunk.textDelta || visibleTextFromParts(chunk.partsDelta ?? [])) return true;
  if ((chunk.functionCalls?.length ?? 0) > 0) return true;
  return (chunk.partsDelta ?? []).some(isUnifiedFunctionCallPart);
}

function visibleTextFromParts(parts: UnifiedPart[]): string {
  return parts.map((part) => 'text' in part && (part as { thought?: unknown }).thought !== true ? part.text ?? '' : '').join('');
}

interface ActiveThoughtBlock {
  startedAt: number;
  thoughtSignature?: string;
}

function emitThoughtDeltas(requestId: string, current: ActiveThoughtBlock | undefined, chunk: UnifiedLLMStreamChunk, at: number, emit: Emit): ActiveThoughtBlock | undefined {
  let block = current;
  for (const part of chunk.partsDelta ?? []) {
    if (!isUnifiedThoughtTextPart(part)) continue;
    const text = part.text ?? '';
    if (!text) continue;
    block ??= { startedAt: at };
    const signature = thoughtSignatureFromPart(part);
    if (signature) block.thoughtSignature = signature;
    emit({
      type: LlmEventType.ThoughtDelta,
      payload: {
        requestId,
        text,
        ...(signature ? { thoughtSignature: signature } : {})
      }
    });
  }
  return block;
}

function shouldCloseThoughtBlock(chunk: UnifiedLLMStreamChunk): boolean {
  return !!chunk.finishReason || hasStreamOutput(chunk);
}

function finishThoughtBlock(requestId: string, block: ActiveThoughtBlock, finishedAt: number, emit: Emit): undefined {
  emit({
    type: LlmEventType.ThoughtDone,
    payload: {
      requestId,
      thoughtDurationMs: Math.max(0, finishedAt - block.startedAt),
      ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {})
    }
  });
  return undefined;
}

function isUnifiedThoughtTextPart(part: UnifiedPart): part is UnifiedPart & { text?: string; thought?: unknown } {
  return 'text' in part && (part as { thought?: unknown }).thought === true;
}

function isUnifiedFunctionCallPart(part: UnifiedPart): part is Extract<UnifiedPart, { functionCall: unknown }> {
  return 'functionCall' in part;
}

function thoughtSignatureFromPart(part: UnifiedPart): string | undefined {
  const value = (part as { thoughtSignature?: unknown }).thoughtSignature;
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function isFunctionParameters(value: unknown): value is UnifiedFunctionDeclaration['parameters'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as { type?: unknown }).type === 'object';
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

async function resolveMaybe<T, TArg = void>(value: MaybeProvider<T, TArg>, arg?: TArg): Promise<T | undefined> {
  if (typeof value === 'function') return (value as (input: TArg | undefined) => T | undefined | Promise<T | undefined>)(arg);
  return value;
}

async function importUnifiedLlmProvider(): Promise<UnifiedModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<UnifiedModule>;
  return dynamicImport('unified-llm-provider');
}

async function createUndiciFetch(): Promise<typeof fetch> {
  const undici = await importUndici();
  // VS Code Extension Host 的 global fetch 可能不是 undici 实现，会忽略 dispatcher。
  // 这里仅在用户显式配置 LLM proxy 时指定 undici.fetch；ProxyAgent/requestTls 仍由 unified-llm-provider@0.1.3 维护。
  return undici.fetch as unknown as typeof fetch;
}

async function importUndici(): Promise<UndiciModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<UndiciModule>;
  return dynamicImport('undici');
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
function emitLlmStarted(emit: Emit, requestId: string, invocationId: string | undefined, model: string | undefined): void {
  emit({ type: LlmEventType.Started, payload: { requestId, ...(invocationId ? { invocationId } : {}), ...(model ? { model } : {}), startedAt: Date.now() } });
}

function emitLlmError(
  emit: Emit,
  requestId: string,
  message: string,
  rawError?: LlmRawErrorInfoRecord,
  extra: { retryAttempt?: number; retryMaxAttempts?: number; createdAt?: number; streamOutputDurationMs?: number } = {}
): void {
  emit({
    type: LlmEventType.Error,
    payload: {
      requestId,
      message,
      ...(rawError ? { rawError } : {}),
      ...(extra.retryAttempt !== undefined ? { retryAttempt: extra.retryAttempt } : {}),
      ...(extra.retryMaxAttempts !== undefined ? { retryMaxAttempts: extra.retryMaxAttempts } : {}),
      ...(extra.createdAt !== undefined ? { createdAt: extra.createdAt } : {}),
      ...(extra.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: extra.streamOutputDurationMs } : {})
    }
  });
}

function emitLlmRetryScheduled(emit: Emit, requestId: string, message: string, rawError: LlmRawErrorInfoRecord | undefined, retryAttempt: number, retryMaxAttempts: number, retryDelayMs: number): void {
  emit({ type: LlmEventType.RetryScheduled, payload: { requestId, message, retryAttempt, retryMaxAttempts, retryDelayMs, createdAt: Date.now(), ...(rawError ? { rawError } : {}) } });
}

function emitLlmRetryStarted(emit: Emit, requestId: string, message: string, rawError: LlmRawErrorInfoRecord | undefined, retryAttempt: number, retryMaxAttempts: number): void {
  emit({ type: LlmEventType.RetryStarted, payload: { requestId, message, retryAttempt, retryMaxAttempts, createdAt: Date.now(), ...(rawError ? { rawError } : {}) } });
}

function emitLlmRetryCancelled(emit: Emit, requestId: string, message: string, retryAttempt: number, retryMaxAttempts: number, rawError?: LlmRawErrorInfoRecord): void {
  emit({ type: LlmEventType.RetryCancelled, payload: { requestId, message, retryAttempt, retryMaxAttempts, createdAt: Date.now(), ...(rawError ? { rawError } : {}) } });
}

function emitLlmRetryRecovered(emit: Emit, requestId: string, message: string, retryAttempt: number, retryMaxAttempts: number): void {
  emit({ type: LlmEventType.RetryRecovered, payload: { requestId, message, retryAttempt, retryMaxAttempts, createdAt: Date.now() } });
}

function assertNever(value: never): never {
  throw new Error(`Unexpected content part: ${String(value)}`);
}
