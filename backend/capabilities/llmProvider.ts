import { createProxyFetch } from './proxyFetch';
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
  DEFAULT_SEGMENTED_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_SEGMENTED_SUMMARY_USER_PROMPT,
  isInlineDataPart,
  DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
  DEFAULT_LLM_RETRY_ON_ERROR,
  isTextPart,
  isVisibleTextPart,
  isProviderContextPart
} from '../../shared/protocol';
import type {
  ContentPart,
  FunctionCallPart,
  FunctionResponsePart,
  InlineDataPart,
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
  proxy?: MaybeProvider<string>;
  compressionSettings?: LlmCompressionSettingsProvider;
  activeCompressionSettings?: (conversationId?: string) => LlmCompressionConfigRecord | undefined | Promise<LlmCompressionConfigRecord | undefined>;

  headers?: MaybeProvider<Record<string, string>>;
  resolveAttachment?: (input: { attachmentId?: string; sourcePath?: string; mimeType?: string; name?: string }) => Promise<InlineDataPart | undefined>;
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

interface LlmAttemptRetryRecoveryNotice {
  retryAttempt: number;
  retryMaxAttempts: number;
}

interface LlmAttemptTimingState {
  firstStreamChunkAt?: number;
  firstStreamChunkMark?: number;
  streamTimingChunkCount: number;
}

const THOUGHT_PROGRESS_INTERVAL_MS = 500;

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
    const proxy = normalizeOptionalString(await resolveMaybe(options.proxy));
    const proxyFetch = proxy ? createProxyFetch(proxy) : undefined;
    const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
    if (proxy) console.log(`[LimCode] LLM proxy enabled: ${proxy}`);
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
        await runLlmAttempt(request, emit, settings, provider, options, signal, sawRetry ? { retryAttempt: retryCount, retryMaxAttempts: maxRetries } : undefined);
        return;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) return;
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
    if (isAbortError(error) || signal?.aborted) return;
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
  options: LlmProviderOptions,
  signal?: AbortSignal,
  retryRecoveryNotice?: LlmAttemptRetryRecoveryNotice
): Promise<void> {
  const preparedRequest = await prepareLlmStartRequestMultimodal(request, options);
  if (settings.stream === false) {
    const response = await provider.chat<UnifiedLLMResponse>(toUnifiedRequest(preparedRequest, settings.generationConfig), {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal
    });
    if (signal?.aborted) throw createAbortError(`Aborted LLM request: ${request.id}`);
    if (hasUnifiedError(response)) {
      throw new LlmAttemptFailureError(failureFromProviderError(response.error, { rawResponse: response.rawResponse }));
    }
    emitRetryRecovered(request.id, emit, retryRecoveryNotice);
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
  let retryRecoveryPending = retryRecoveryNotice !== undefined;
  try {
    for await (const chunk of provider.chatStream<UnifiedLLMStreamChunk>(toUnifiedRequest(preparedRequest, settings.generationConfig), {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal
    })) {
      if (signal?.aborted) throw createAbortError(`Aborted LLM request: ${request.id}`);
      if (hasUnifiedError(chunk)) {
        const failure = failureFromProviderError(chunk.error, {
          rawChunk: (chunk as { rawChunk?: unknown }).rawChunk ?? chunk,
          ...createDoneTiming(timing.firstStreamChunkAt, Date.now(), timing.firstStreamChunkMark, nowMonotonicMs(), timing.streamTimingChunkCount)
        });
        throw new LlmAttemptFailureError(failure);
      }
      const chunkAt = Date.now();
      const chunkMark = nowMonotonicMs();
      if (retryRecoveryPending && hasStreamTimingChunk(chunk)) {
        emitRetryRecovered(request.id, emit, retryRecoveryNotice);
        retryRecoveryPending = false;
      }
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
    const aborted = isAbortError(error) || signal?.aborted;
    if (activeThoughtBlock) activeThoughtBlock = aborted
      ? disposeThoughtBlock(activeThoughtBlock)
      : finishThoughtBlock(request.id, activeThoughtBlock, Date.now(), emit);
    if (aborted) throw createAbortError(`Aborted LLM request: ${request.id}`);
    throw error;
  }

  if (signal?.aborted) throw createAbortError(`Aborted LLM request: ${request.id}`);
  const finishedAt = Date.now();
  const finishedMark = nowMonotonicMs();
  if (activeThoughtBlock) finishThoughtBlock(request.id, activeThoughtBlock, finishedAt, emit);
  if (retryRecoveryPending) emitRetryRecovered(request.id, emit, retryRecoveryNotice);
  emit({
    type: LlmEventType.Done,
    payload: { requestId: request.id, ...createDoneTiming(timing.firstStreamChunkAt, finishedAt, timing.firstStreamChunkMark, finishedMark, timing.streamTimingChunkCount), ...(latestUsageMetadata ? { usageMetadata: latestUsageMetadata } : {}) }
  });
}

function emitRetryRecovered(requestId: string, emit: Emit, notice: LlmAttemptRetryRecoveryNotice | undefined): void {
  if (!notice) return;
  emitLlmRetryRecovered(emit, requestId, '自动重试成功。', notice.retryAttempt, notice.retryMaxAttempts);
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
  const proxy = normalizeOptionalString(await resolveMaybe(options.proxy));
  const proxyFetch = proxy ? createProxyFetch(proxy) : undefined;
  const headers = mergeHeaders(await resolveMaybe(options.headers), runtimeSettings.headers);
  const provider = unified.createLLMFromConfig({
    provider: runtimeSettings.provider,
    model: runtimeSettings.model,
    apiKey: runtimeSettings.apiKey,
    baseUrl: runtimeSettings.baseUrl,
    ...(runtimeSettings.contextWindowTokens ? { contextWindow: runtimeSettings.contextWindowTokens } : {}),
    ...(headers ? { headers } : {}),
    ...(runtimeSettings.requestBody ? { requestBody: runtimeSettings.requestBody } : {}),
    ...(proxy ? { proxy, fetch: proxyFetch } : {})
  }, registry.llmProviders);

  const dryRun = (provider as unknown as Partial<UnifiedDryRunCapable>).dryRun;
  if (typeof dryRun !== 'function') {
    throw new Error('当前 unified-llm-provider 版本不支持 provider.dryRun，请更新依赖。');
  }

  const preparedRequest = await prepareLlmStartRequestMultimodal(request, options);
  const result = await dryRun.call(provider, toUnifiedRequest(preparedRequest, runtimeSettings.generationConfig), {
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
  registerLlmCompressionMethod('segmented_summary', compactWithSegmentedSummary);
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
  const proxy = normalizeOptionalString(await resolveMaybe(options.proxy));
  const proxyFetch = proxy ? createProxyFetch(proxy) : undefined;
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

/**
 * 分段总结拼接：按回合分别总结后机械拼接。
 * - 每个回合并行调用 LLM 总结（回合1前情=历史总结，回合N前情=上一回合的最终正式回答原文）；
 * - 提取每段 <summary></summary>，无标签则回退原文；
 * - 拼接为 [过去总结逐字?] + ## 回合N，包裹成 [Context Summary]。
 */
async function compactWithSegmentedSummary(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal
): Promise<LlmCompactResult> {
  const segments = request.segments && request.segments.length > 0 ? request.segments : [request.contents];
  const provider = await resolveSummaryProvider(request, methodConfig, options);

  // 分段模式固定使用内置中文分段提示词，不复用 llmSummary 的通用 systemPrompt/userPrompt(避免存量配置污染)；
  // provider/model/generationConfig 仍从 llmSummary 读取，“跟随当前渠道”不受影响。
  const summarySettings = methodConfig.llmSummary;
  const systemPrompt = DEFAULT_SEGMENTED_SUMMARY_SYSTEM_PROMPT;
  const userPrompt = DEFAULT_SEGMENTED_SUMMARY_USER_PROMPT;

  const priorSummaryText = request.priorSummaryContents?.length ? plainTextOfContents(request.priorSummaryContents) : '';
  const priorContexts = segments.map((segment, index) => {
    if (index === 0) return priorSummaryText;
    return finalAnswerTextOf(segments[index - 1]);
  });

  const roundSummaries = await Promise.all(segments.map((segment, index) =>
    summarizeSingleRound(provider, { systemPrompt, userPrompt, generationConfig: summarySettings?.generationConfig }, segment, priorContexts[index] || '无', signal)
  ));

  const parts: string[] = [];
  if (priorSummaryText) parts.push(`━━━ 早前对话摘要 ━━━\n${priorSummaryText}`);
  roundSummaries.forEach((summary, index) => parts.push(`━━━ 回合 ${index + 1} ━━━\n${summary}`));
  const joined = parts.join('\n\n');

  const contents: MessageContent[] = [{ role: 'user', parts: [{ text: `[Context Summary]\n\n${joined}` }] }];
  return {
    id: `summary-${request.blockId}`,
    object: 'limcode.context_summary',
    createdAt: Date.now(),
    contents,
    ...(provider.settings ? { settingsSnapshot: snapshotFromSettings(provider.settings, methodConfig) } : {}),
    methodConfig
  };
}

/** 提取内容里的可见文本（用于逐字保留历史总结，不加 role 前缀）；剥离外层 [Context Summary] 标签避免嵌套。 */
function plainTextOfContents(contents: MessageContent[]): string {
  const text = contents
    .flatMap((content) => content.parts.filter(isVisibleTextPart).map((part) => part.text))
    .join('\n')
    .trim();
  return text.replace(/^\[Context Summary\]\s*/, '').trim();
}

/** 取一个回合中最后一条“正式回答”(model + 可见文本) 的可见文本，用作下一回合前情。 */
function finalAnswerTextOf(segment: MessageContent[]): string {
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    const content = segment[index];
    if (content.role !== 'model') continue;
    const text = content.parts.filter(isVisibleTextPart).map((part) => part.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

const SUMMARY_TAG_PATTERN = /<summary>([\s\S]*?)<\/summary>/i;
function extractSummaryTag(text: string): string {
  const match = SUMMARY_TAG_PATTERN.exec(text);
  return (match ? match[1] : text).trim();
}

interface ResolvedSummaryProvider {
  provider: ReturnType<UnifiedModule['createLLMFromConfig']> | undefined;
  settings: LlmProviderConfigRecord;
  stream: boolean;
}

/** 组装总结用 provider（复用运行时渠道解析 + 代理/头合并）；无 API Key 时 provider 为 undefined 表示回退确定性摘要。 */
async function resolveSummaryProvider(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions
): Promise<ResolvedSummaryProvider> {
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

  if (!settings.apiKey) return { provider: undefined, settings, stream: false };

  const unified = await importUnifiedLlmProvider();
  const registry = unified.createBootstrapExtensionRegistry();
  const proxy = normalizeOptionalString(await resolveMaybe(options.proxy));
  const proxyFetch = proxy ? createProxyFetch(proxy) : undefined;
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
  return { provider, settings, stream: settings.stream !== false };
}

interface SummaryPromptSettings { systemPrompt: string; userPrompt: string; generationConfig?: LlmGenerationConfigRecord }

async function summarizeSingleRound(
  resolved: ResolvedSummaryProvider,
  prompt: SummaryPromptSettings,
  segment: MessageContent[],
  priorContext: string,
  signal?: AbortSignal
): Promise<string> {
  const fallback = () => deterministicSummary(segment);
  if (!resolved.provider) return fallback();

  const transcript = renderContentsForSummary(segment);
  const userText = `${prompt.userPrompt}\n\n【前情(只读，不要重新总结)】\n${priorContext}\n\n【本回合记录】\n${transcript}`;
  const summaryRequest = {
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    systemInstruction: { parts: [{ text: prompt.systemPrompt }] },
    generationConfig: prompt.generationConfig ?? resolved.settings.generationConfig
  };

  if (resolved.stream) {
    let text = '';
    for await (const chunk of resolved.provider.chatStream<UnifiedLLMStreamChunk>(summaryRequest, { inputFormat: 'unified', outputFormat: 'unified', signal })) {
      text += chunk.textDelta ?? visibleTextFromParts(chunk.partsDelta ?? []);
    }
    const trimmed = text.trim();
    return trimmed ? extractSummaryTag(trimmed) : fallback();
  }

  const response = await resolved.provider.chat<UnifiedLLMResponse>(summaryRequest, { inputFormat: 'unified', outputFormat: 'unified', signal });
  const trimmed = visibleTextFromParts(response.content?.parts ?? []).trim();
  return trimmed ? extractSummaryTag(trimmed) : fallback();
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

  const resolved = await resolveSummaryProvider(request, methodConfig, options);
  if (!resolved.provider) return { text: deterministicSummary(request.contents), settings: resolved.settings };

  const summarySettings = methodConfig.llmSummary;
  const systemPrompt = summarySettings?.systemPrompt?.trim() || DEFAULT_LLM_COMPRESSION_SUMMARY_SYSTEM_PROMPT;
  const userPrompt = summarySettings?.userPrompt?.trim() || DEFAULT_LLM_COMPRESSION_SUMMARY_USER_PROMPT;
  const transcript = renderContentsForSummary(request.contents);
  const summaryRequest = {
    contents: [{ role: 'user', parts: [{ text: `${userPrompt}\n\n${transcript}` }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: summarySettings?.generationConfig ?? resolved.settings.generationConfig
  };

  if (resolved.stream) {
    let text = '';
    for await (const chunk of resolved.provider.chatStream<UnifiedLLMStreamChunk>(summaryRequest, { inputFormat: 'unified', outputFormat: 'unified', signal })) {
      text += chunk.textDelta ?? visibleTextFromParts(chunk.partsDelta ?? []);
    }
    return { text: text.trim() || deterministicSummary(request.contents), settings: resolved.settings };
  }

  const response = await resolved.provider.chat<UnifiedLLMResponse>(summaryRequest, { inputFormat: 'unified', outputFormat: 'unified', signal });

  const text = visibleTextFromParts(response.content?.parts ?? []).trim();
  return { text: text || deterministicSummary(request.contents), settings: resolved.settings };
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
  const thoughtSignature = thoughtSignatureFromPart(part);
  const call = record.functionCall;
  if (isRecord(call) && typeof call.name === 'string') {
    return {
      id: typeof call.callId === 'string' ? call.callId : undefined,
      functionCall: { name: call.name, args: call.args ?? {} },
      ...(thoughtSignature ? { thoughtSignature } : {})
    };
  }
  if (typeof record.text === 'string' || typeof record.thought === 'boolean' || thoughtSignature) {
    return {
      text: typeof record.text === 'string' ? record.text : '',
      ...(typeof record.thought === 'boolean' ? { thought: record.thought } : thoughtSignature && typeof record.text !== 'string' ? { thought: true } : {}),
      ...(thoughtSignature ? { thoughtSignature } : {}),
      ...(typeof record.thoughtElapsedMs === 'number' ? { thoughtElapsedMs: record.thoughtElapsedMs } : {}),
      ...(typeof record.thoughtDurationMs === 'number' ? { thoughtDurationMs: record.thoughtDurationMs } : {})
    };
  }
  const response = record.functionResponse;
  if (isRecord(response) && typeof response.name === 'string') {
    const parts = Array.isArray(response.parts)
      ? response.parts.map(fromUnifiedPart).filter((part): part is InlineDataPart => !!part && isInlineDataPart(part))
      : [];
    return {
      id: typeof response.callId === 'string' ? response.callId : undefined,
      functionResponse: {
        name: response.name,
        response: response.response ?? {},
        ...(parts.length > 0 ? { parts } : {})
      }
    };
  }
  const inlineData = record.inlineData;
  if (isRecord(inlineData) && typeof inlineData.mimeType === 'string' && typeof inlineData.data === 'string') {
    return { inlineData: { mimeType: inlineData.mimeType, data: inlineData.data, ...(typeof inlineData.name === 'string' ? { name: inlineData.name } : {}) } };
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
    enableMultimodalTools: settings?.enableMultimodalTools !== false,
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
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
    enableMultimodalTools: settings.enableMultimodalTools !== false,
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

const TOOL_RESPONSE_MULTIMODAL_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain']);
const TOOL_RESPONSE_CONTEXT_FALLBACK_MESSAGE = '工具调用在本次 LLM 请求上下文中没有对应响应，已自动补充兜底响应。原工具执行结果不可用；如仍需要结果，请重新执行相关操作。';

interface ToolCallContextNormalizationResult {
  contents: MessageContent[];
  orphanResponseCount: number;
  fallbackResponseCount: number;
}

interface TrackedFunctionCall {
  part: FunctionCallPart;
  contentIndex: number;
  closed: boolean;
}

async function prepareLlmStartRequestMultimodal(request: LlmStartRequest, options: LlmProviderOptions): Promise<LlmStartRequest> {
  const [contents, systemInstruction] = await Promise.all([
    Promise.all(request.contents.map((content) => prepareLlmContentMultimodal(content, options, false))),
    request.systemInstruction ? prepareLlmContentMultimodal(request.systemInstruction, options, false) : Promise.resolve(undefined)
  ]);
  const normalized = normalizeToolCallResponseContext(contents);
  if (normalized.orphanResponseCount > 0 || normalized.fallbackResponseCount > 0) {
    console.info(`[LimCode] Normalized tool call context for LLM request "${request.id}": orphanResponses=${normalized.orphanResponseCount}, fallbackResponses=${normalized.fallbackResponseCount}.`);
  }
  return {
    ...request,
    contents: normalized.contents,
    ...(systemInstruction ? { systemInstruction } : {})
  };
}

function normalizeToolCallResponseContext(contents: MessageContent[]): ToolCallContextNormalizationResult {
  const pendingById = new Map<string, TrackedFunctionCall>();
  const pendingByName = new Map<string, TrackedFunctionCall[]>();
  const calls: TrackedFunctionCall[] = [];
  let orphanResponseCount = 0;

  const normalized = contents.map((content, contentIndex) => {
    let changed = false;
    const parts = content.parts.map((part) => {
      if (isFunctionCallPart(part)) {
        const tracked: TrackedFunctionCall = { part, contentIndex, closed: false };
        calls.push(tracked);
        const id = normalizeToolCallId(part.id);
        if (id) {
          pendingById.set(id, tracked);
        } else {
          const list = pendingByName.get(part.functionCall.name) ?? [];
          list.push(tracked);
          pendingByName.set(part.functionCall.name, list);
        }
        return part;
      }

      if (!isFunctionResponsePart(part)) return part;

      const matched = consumeMatchingFunctionCall(part, pendingById, pendingByName);
      if (matched) return part;

      orphanResponseCount += 1;
      changed = true;
      return orphanFunctionResponseTextPart(part);
    });
    return changed ? { ...content, parts } : content;
  });

  const fallbackResponsesByContentIndex = new Map<number, FunctionResponsePart[]>();
  for (const call of calls) {
    if (call.closed) continue;
    const list = fallbackResponsesByContentIndex.get(call.contentIndex) ?? [];
    list.push(fallbackFunctionResponsePart(call.part));
    fallbackResponsesByContentIndex.set(call.contentIndex, list);
  }

  if (fallbackResponsesByContentIndex.size === 0) {
    return { contents: normalized, orphanResponseCount, fallbackResponseCount: 0 };
  }

  const repaired: MessageContent[] = [];
  let fallbackResponseCount = 0;
  normalized.forEach((content, index) => {
    repaired.push(content);
    const fallbackResponses = fallbackResponsesByContentIndex.get(index);
    if (!fallbackResponses?.length) return;
    fallbackResponseCount += fallbackResponses.length;
    repaired.push({ role: 'user', parts: fallbackResponses });
  });

  return { contents: repaired, orphanResponseCount, fallbackResponseCount };
}

function consumeMatchingFunctionCall(
  response: FunctionResponsePart,
  pendingById: Map<string, TrackedFunctionCall>,
  pendingByName: Map<string, TrackedFunctionCall[]>
): TrackedFunctionCall | undefined {
  const responseId = normalizeToolCallId(response.id);
  if (responseId) {
    const matched = pendingById.get(responseId);
    if (matched) {
      matched.closed = true;
      pendingById.delete(responseId);
      return matched;
    }
  }

  const queue = pendingByName.get(response.functionResponse.name);
  const matched = queue?.shift();
  if (!matched) return undefined;
  matched.closed = true;
  if (queue && queue.length === 0) pendingByName.delete(response.functionResponse.name);
  return matched;
}

function orphanFunctionResponseTextPart(part: FunctionResponsePart): ContentPart {
  return {
    text: [
      '[工具响应上下文兜底]',
      '原因: 当前 LLM 请求上下文中没有找到这条工具响应对应的工具调用，已转为普通文本，避免 provider 拒绝请求。',
      `name: ${part.functionResponse.name}`,
      ...(part.id ? [`callId: ${part.id}`] : []),
      `response: ${stringifyJson(part.functionResponse.response)}`
    ].join('\n')
  };
}

function fallbackFunctionResponsePart(call: FunctionCallPart): FunctionResponsePart {
  return {
    ...(call.id ? { id: call.id } : {}),
    functionResponse: {
      name: call.functionCall.name,
      response: {
        ok: false,
        status: 'error',
        recovered: true,
        interrupted: true,
        message: TOOL_RESPONSE_CONTEXT_FALLBACK_MESSAGE,
        ...(call.id ? { toolCallId: call.id } : {})
      }
    }
  };
}

function normalizeToolCallId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

async function prepareLlmContentMultimodal(content: MessageContent, options: LlmProviderOptions, toolResponse: boolean): Promise<MessageContent> {
  const parts = await Promise.all(content.parts.map((part) => prepareLlmPartMultimodal(part, options, toolResponse)));
  return { ...content, parts: parts.flat() };
}

async function prepareLlmPartMultimodal(part: ContentPart, options: LlmProviderOptions, toolResponse: boolean): Promise<ContentPart[]> {
  if (isInlineDataPart(part)) return [await prepareInlineDataForLlm(part, options, toolResponse)];
  if (isFunctionResponsePart(part) && part.functionResponse.parts?.length) {
    const prepared = await Promise.all(part.functionResponse.parts.map((inlinePart) => prepareInlineDataForLlm(inlinePart, options, true)));
    const inlineParts = prepared.filter(isInlineDataPart).filter((inlinePart) => isSupportedToolResponseInlineData(inlinePart));
    const placeholders = prepared.filter(isTextPart).map((textPart) => textPart.text).filter(Boolean);
    return [{
      ...part,
      functionResponse: {
        ...part.functionResponse,
        response: placeholders.length > 0 ? withAttachmentPlaceholders(part.functionResponse.response, placeholders) : part.functionResponse.response,
        ...(inlineParts.length > 0 ? { parts: inlineParts } : {})
      }
    }];
  }
  return [part];
}

async function prepareInlineDataForLlm(part: InlineDataPart, options: LlmProviderOptions, toolResponse: boolean): Promise<ContentPart> {
  if (toolResponse && !isSupportedToolResponseInlineData(part)) return attachmentPlaceholderPart(part, '附件类型不在工具响应白名单中');
  if (part.inlineData.data) return part;
  const resolved = options.resolveAttachment
    ? await options.resolveAttachment({
      attachmentId: part.inlineData.attachmentId,
      sourcePath: part.inlineData.sourcePath,
      mimeType: part.inlineData.mimeType,
      name: part.inlineData.name
    })
    : undefined;
  if (resolved?.inlineData.data) return resolved;
  return attachmentPlaceholderPart(part, resolved?.inlineData.error ?? '附件读取失败');
}

function isSupportedToolResponseInlineData(part: InlineDataPart): boolean {
  return TOOL_RESPONSE_MULTIMODAL_MIME_TYPES.has(part.inlineData.mimeType);
}

function withAttachmentPlaceholders(response: unknown, placeholders: string[]): unknown {
  const key = 'multimodalAttachmentPlaceholders';
  if (isRecord(response)) {
    const previous = Array.isArray(response[key]) ? response[key].filter((item): item is string => typeof item === 'string') : [];
    return { ...response, [key]: [...previous, ...placeholders] };
  }
  return { response, [key]: placeholders };
}

function attachmentPlaceholderPart(part: InlineDataPart, reason: string): ContentPart {
  const name = part.inlineData.name || part.inlineData.sourcePath || part.inlineData.attachmentId || '未命名附件';
  return {
    text: `[附件不可用: ${name}; mimeType=${part.inlineData.mimeType}; reason=${reason}]`
  };
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
    const thoughtSignatures = thoughtSignaturesFromPortableSignature(part.thoughtSignature);
    return {
      text: part.text,
      ...(part.thought !== undefined ? { thought: part.thought } : {}),
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      ...(thoughtSignatures ? { thoughtSignatures } : {}),
      ...(part.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: part.thoughtElapsedMs } : {})
    };
  }
  if (isFunctionCallPart(part)) {
    const thoughtSignatures = thoughtSignaturesFromPortableSignature(part.thoughtSignature);
    return {
      functionCall: { name: part.functionCall.name, args: asRecord(part.functionCall.args), ...(part.id ? { callId: part.id } : {}) },
      // Gemini 会校验带工具调用的 thoughtSignature；作为 part 同层级字段透传给 provider。
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      ...(thoughtSignatures ? { thoughtSignatures } : {})
    };
  }
  if (isFunctionResponsePart(part)) {
    const functionResponse: Record<string, unknown> = {
      name: part.functionResponse.name,
      response: asRecord(part.functionResponse.response),
      ...(part.id ? { callId: part.id } : {})
    };
    const inlineParts = (part.functionResponse.parts ?? [])
      .filter((inlinePart) => inlinePart.inlineData.data)
      .map((inlinePart) => ({
        inlineData: {
          mimeType: inlinePart.inlineData.mimeType,
          data: inlinePart.inlineData.data!,
          ...(inlinePart.inlineData.name ? { name: inlinePart.inlineData.name } : {})
        }
      }));
    if (inlineParts.length > 0) functionResponse.parts = inlineParts;
    return {
      functionResponse
    } as unknown as UnifiedPart;
  }
  if (isInlineDataPart(part)) return part.inlineData.data
    ? { inlineData: { mimeType: part.inlineData.mimeType, data: part.inlineData.data, ...(part.inlineData.name ? { name: part.inlineData.name } : {}) } }
    : { text: `[inlineData unavailable: ${part.inlineData.name ?? part.inlineData.attachmentId ?? part.inlineData.sourcePath ?? part.inlineData.mimeType}]` };
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

  const thoughtParts = parts.filter(isUnifiedThoughtTextPart);
  for (const part of thoughtParts) {
    const text = typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '';
    const signature = thoughtSignatureFromPart(part);
    if (text) emit({ type: LlmEventType.ThoughtDelta, payload: { requestId, text, thoughtElapsedMs: 0, ...(signature ? { thoughtSignature: signature } : {}) } });
    if (text || signature) emit({ type: LlmEventType.ThoughtDone, payload: { requestId, thoughtDurationMs: 0, ...(signature ? { thoughtSignature: signature } : {}) } });
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
  return !!thoughtSignatureFromChunk(chunk) || (chunk.partsDelta ?? []).some((part) => isUnifiedThoughtTextPart(part) && (!!part.text || !!thoughtSignatureFromPart(part)));
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
  progressTimer?: ReturnType<typeof setInterval>;
  thoughtSignature?: string;
}

function emitThoughtDeltas(requestId: string, current: ActiveThoughtBlock | undefined, chunk: UnifiedLLMStreamChunk, at: number, emit: Emit): ActiveThoughtBlock | undefined {
  let block = current;
  const chunkSignature = thoughtSignatureFromChunk(chunk);
  if (chunkSignature) {
    block ??= createActiveThoughtBlock(requestId, at, emit);
    block.thoughtSignature = chunkSignature;
  }
  for (const part of chunk.partsDelta ?? []) {
    if (!isUnifiedThoughtTextPart(part)) continue;
    const text = part.text ?? '';
    block ??= createActiveThoughtBlock(requestId, at, emit);
    const signature = thoughtSignatureFromPart(part);
    if (signature) block.thoughtSignature = signature;
    if (!text) continue;
    emit({
      type: LlmEventType.ThoughtDelta,
      payload: {
        requestId,
        text,
        thoughtElapsedMs: Math.max(0, at - block.startedAt),
        ...(signature ? { thoughtSignature: signature } : {})
      }
    });
  }
  return block;
}

function createActiveThoughtBlock(requestId: string, startedAt: number, emit: Emit): ActiveThoughtBlock {
  const block: ActiveThoughtBlock = { startedAt };
  block.progressTimer = setInterval(() => {
    emit({
      type: LlmEventType.ThoughtProgress,
      payload: {
        requestId,
        thoughtElapsedMs: Math.max(0, Date.now() - block.startedAt),
        ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {})
      }
    });
  }, THOUGHT_PROGRESS_INTERVAL_MS);
  return block;
}

function disposeThoughtBlock(block: ActiveThoughtBlock): undefined {
  if (block.progressTimer) clearInterval(block.progressTimer);
  return undefined;
}

function shouldCloseThoughtBlock(chunk: UnifiedLLMStreamChunk): boolean {
  return !!chunk.finishReason || hasStreamOutput(chunk) || hasThoughtSignatureOnlyOutput(chunk);
}

function finishThoughtBlock(requestId: string, block: ActiveThoughtBlock, finishedAt: number, emit: Emit): undefined {
  disposeThoughtBlock(block);
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
  return (part as { thought?: unknown }).thought === true;
}

function isUnifiedFunctionCallPart(part: UnifiedPart): part is Extract<UnifiedPart, { functionCall: unknown }> {
  return 'functionCall' in part;
}

function thoughtSignatureFromPart(part: UnifiedPart): string | undefined {
  const record = part as { thoughtSignature?: unknown; thoughtSignatures?: unknown };
  return normalizedSignatureString(record.thoughtSignature) ?? portableThoughtSignatureFromMap(record.thoughtSignatures);
}

function thoughtSignatureFromChunk(chunk: UnifiedLLMStreamChunk): string | undefined {
  const record = chunk as { thoughtSignature?: unknown; thoughtSignatures?: unknown };
  return normalizedSignatureString(record.thoughtSignature) ?? portableThoughtSignatureFromMap(record.thoughtSignatures);
}

function hasThoughtSignatureOnlyOutput(chunk: UnifiedLLMStreamChunk): boolean {
  const parts = chunk.partsDelta ?? [];
  const hasSignature = !!thoughtSignatureFromChunk(chunk) || parts.some((part) => isUnifiedThoughtTextPart(part) && !!thoughtSignatureFromPart(part));
  if (!hasSignature) return false;
  return !parts.some((part) => isUnifiedThoughtTextPart(part) && !!part.text);
}

function normalizedSignatureString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

const THOUGHT_SIGNATURE_PROVIDER_ORDER = ['gemini', 'claude', 'openai-compatible', 'openai-responses'] as const;

function portableThoughtSignatureFromMap(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const provider of THOUGHT_SIGNATURE_PROVIDER_ORDER) {
    const signature = portableThoughtSignatureFromEntry(provider, value[provider]);
    if (signature) return signature;
  }
  for (const [provider, raw] of Object.entries(value)) {
    const signature = portableThoughtSignatureFromEntry(provider, raw);
    if (signature) return signature;
  }
  return undefined;
}

function portableThoughtSignatureFromEntry(provider: string, raw: unknown): string | undefined {
  const signature = normalizedSignatureString(raw);
  if (!signature) return undefined;
  const parsedSignature = parsePortableThoughtSignature(signature);
  if (parsedSignature) return `${parsedSignature.provider}:${parsedSignature.value}`;
  const normalizedProvider = normalizedSignatureProvider(provider);
  return normalizedProvider ? `${normalizedProvider}:${signature}` : undefined;
}

function thoughtSignaturesFromPortableSignature(signature: string | undefined): Record<string, string> | undefined {
  const normalized = normalizedSignatureString(signature);
  if (!normalized) return undefined;
  const parsed = parsePortableThoughtSignature(normalized);
  return parsed ? { [parsed.provider]: parsed.value } : undefined;
}

function parsePortableThoughtSignature(signature: string): { provider: string; value: string } | undefined {
  const colonIndex = signature.indexOf(':');
  if (colonIndex <= 0) return undefined;
  const provider = normalizedSignatureProvider(signature.slice(0, colonIndex));
  const value = signature.slice(colonIndex + 1).trim();
  if (!provider || !value) return undefined;
  return { provider, value };
}

function normalizedSignatureProvider(provider: string): string | undefined {
  const normalized = provider.trim().toLowerCase();
  if (!normalized || normalized === 'openai' || !/^[a-z0-9_-]+$/.test(normalized)) return undefined;
  return normalized;
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
