/**
 * OpenAI Responses WebSocket transport.
 *
 * This module keeps WebSocket continuation state as a transport optimization only.
 * The caller must still provide the full local context on every request; the
 * transport decides whether it can safely send only the incremental suffix with
 * previous_response_id, and falls back to full input whenever local context no
 * longer matches the connection-local state.
 */

import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { Agent as UndiciAgent, ProxyAgent as UndiciProxyAgent, WebSocket as UndiciWebSocket } from 'undici';
import type { LLMProxyOption } from '../config/types.js';
import type { LLMRawErrorInfo, LLMRequest, LLMResponse, LLMStreamChunk } from '../types.js';
import type { FormatAdapter } from './formats/types.js';
import type { EndpointConfig } from './transport.js';

const OPENAI_RESPONSES_WS_MAX_AGE_MS = 55 * 60 * 1000;
const OPENAI_RESPONSES_WS_CONNECT_TIMEOUT_MS = 10 * 1000;
const OPENAI_RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS = 8 * 1000;
const OPENAI_RESPONSES_WS_RESPONSE_IDLE_TIMEOUT_MS = 30 * 1000;
const OPENAI_RESPONSES_WS_NETWORK_CHECK_INTERVAL_MS = 1_000;
const OPENAI_RESPONSES_WS_MAX_REQUEST_ATTEMPTS = 3;
const OPENAI_RESPONSES_WS_RECONNECT_DELAYS_MS = [250, 750] as const;
const OPENAI_RESPONSES_WS_RETRYABLE_CLOSE_CODES = new Set([1006, 1011, 1012, 1013, 1014]);
const OPENAI_RESPONSES_WS_RETRYABLE_PROVIDER_ERROR_CODES = new Set([
  'previous_response_not_found',
  'websocket_connection_limit_reached',
  'rate_limit_exceeded',
  'server_error',
  'internal_error',
  'service_unavailable',
  'timeout',
]);
const OPENAI_RESPONSES_WS_NON_RETRYABLE_PROVIDER_ERROR_CODES = new Set([
  'invalid_api_key',
  'authentication_error',
  'permission_denied',
  'invalid_request_error',
  'context_length_exceeded',
  'insufficient_quota',
  'billing_hard_limit_reached',
]);

type OpenAIResponsesWebSocketPhase =
  | 'connecting'
  | 'sending_response_create'
  | 'awaiting_first_event'
  | 'streaming';

interface OpenAIResponsesWebSocketErrorMetadata {
  transport?: 'websocket';
  phase?: OpenAIResponsesWebSocketPhase;
  code?: string;
  closeCode?: number;
  closeReason?: string;
  closeWasClean?: boolean;
  receivedServerEvent?: boolean;
  attempt?: number;
  maxAttempts?: number;
  retryable?: boolean;
}

class OpenAIResponsesWebSocketCloseError extends Error implements OpenAIResponsesWebSocketErrorMetadata {
  public readonly transport = 'websocket' as const;
  public readonly closeCode: number;
  public readonly closeReason?: string;
  public readonly closeWasClean: boolean;
  public readonly retryable: boolean;

  public constructor(
    event: CloseEvent,
    public readonly phase: OpenAIResponsesWebSocketPhase,
    public readonly receivedServerEvent: boolean,
  ) {
    const reason = event.reason.trim();
    const prefix = phase === 'connecting'
      ? 'OpenAI Responses WebSocket closed before open'
      : 'OpenAI Responses WebSocket closed';
    super(`${prefix}: ${event.code}${reason ? ` ${reason}` : ''}`);
    this.name = 'WebSocketCloseError';
    this.closeCode = event.code;
    this.closeReason = reason || undefined;
    this.closeWasClean = event.wasClean;
    this.retryable = isRetryableWebSocketClose(event.code, reason);
  }
}

interface WebSocketSession {
  key: string;
  connectionFingerprint: string;
  socket?: UndiciWebSocket;
  connectedAt?: number;
  previousResponseId?: string;
  serverInputItems?: unknown[];
  baseSignature?: string;
  lock?: Promise<void>;
}

interface PreparedCreatePayload {
  payload: Record<string, unknown>;
  fullInputItems: unknown[];
  baseSignature: string;
  decision: 'full' | 'incremental';
  decisionReason: string;
  usedPreviousResponseId?: string;
}

export interface StreamedReasoningSignatureRecord {
  itemId?: string;
  outputIndex?: number;
  encryptedContent?: string;
}

export interface OpenAIResponsesWebSocketStreamOptions {
  endpoint: EndpointConfig;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  format: FormatAdapter;
  signal?: AbortSignal;
  /** Overrides the 10-second connection deadline, primarily for transport tests. */
  connectTimeoutMs?: number;
  /** Overrides the 8-second first inbound-event deadline, primarily for transport tests. */
  firstEventTimeoutMs?: number;
  /** Overrides the 30-second inbound-event inactivity deadline, primarily for transport tests. */
  responseIdleTimeoutMs?: number;
  /** Overrides the local network identity hash, primarily for transport tests. */
  networkIdentityFingerprint?: string | (() => string);
  /** Overrides active-request network identity polling, primarily for transport tests. */
  networkIdentityCheckIntervalMs?: number;
}

interface QueuedMessage {
  value?: unknown;
  done?: boolean;
  error?: unknown;
}

interface NormalizedWebSocketProxy {
  uri: string;
  headers?: Record<string, string>;
  cacheKey: string;
}

const sessions = new Map<string, WebSocketSession>();
let statelessSessionCounter = 0;

export function resetOpenAIResponsesWebSocketSessions(): void {
  for (const session of sessions.values()) {
    closeSessionSocket(session);
    invalidateSessionState(session);
  }
  sessions.clear();
  statelessSessionCounter = 0;
}

export async function* streamOpenAIResponsesWebSocket(
  options: OpenAIResponsesWebSocketStreamOptions,
): AsyncGenerator<LLMStreamChunk> {
  const fullBody = sanitizeResponsesCreateBody(options.body);
  const initialConnectionFingerprint = webSocketConnectionFingerprintForOptions(options);
  const session = sessionFor(options.endpoint, options.url, options.headers, initialConnectionFingerprint);
  const release = await acquireSessionLock(session, options.signal);

  try {
    let allowIncremental = true;
    for (let attempt = 0; attempt < OPENAI_RESPONSES_WS_MAX_REQUEST_ATTEMPTS; attempt += 1) {
      synchronizeSessionConnection(session, webSocketConnectionFingerprintForOptions(options));
      // Continuation state is connection-local. Select or create the socket first so
      // a replacement connection can invalidate old state before payload preparation.
      let socket: UndiciWebSocket;
      try {
        socket = await ensureOpenSocket(session, options, attempt > 0);
      } catch (error) {
        if (isAbortError(options.signal, error)) throw error;
        const normalized = withWebSocketAttemptContext(
          normalizeWebSocketTransportError(error),
          attempt + 1,
          'connecting',
          false,
          attempt + 1,
        );
        invalidateSessionState(session);
        allowIncremental = false;
        // Connection setup already has its own deadline. Repeating that slow wait
        // here would multiply with the caller's retry policy (3 physical attempts
        // per outer attempt in LimCode), so connection failures are surfaced once.
        throw normalized;
      }

      const prepared = prepareCreatePayload(session, fullBody, allowIncremental);
      let completedResponse: unknown;
      let responseId = responseIdFromPayload(prepared.payload);
      let shouldRetryFull = false;
      let retryAfterTransportFailure = false;
      let completed = false;
      let sawServerEvent = false;
      let sawSemanticOutput = false;
      const completedOutputItems: unknown[] = [];
      const completedOutputKeys = new Map<string, number>();
      const streamedReasoningSignatures: StreamedReasoningSignatureRecord[] = [];

      const state = options.format.createStreamState();

      try {
        for await (const raw of sendCreateAndReadEvents(
          session,
          socket,
          prepared.payload,
          options,
        )) {
          sawServerEvent = true;
          const type = eventType(raw);
          captureCompletedOutputItem(raw, completedOutputItems, completedOutputKeys);
          captureStreamedReasoningSignature(raw, streamedReasoningSignatures);
          responseId = responseIdFromPayload(raw) ?? responseId;
          completedResponse = completedResponseFromPayload(raw) ?? completedResponse;
          if (type === 'response.completed') completed = true;
          if (isSemanticOutputEvent(type)) sawSemanticOutput = true;

          if (isProviderErrorPayload(raw)) {
            closeAndInvalidateSessionSocket(session, socket);
            if (isRecoverableContinuationError(raw)
              && attempt + 1 < OPENAI_RESPONSES_WS_MAX_REQUEST_ATTEMPTS) {
              shouldRetryFull = true;
              allowIncremental = false;
              break;
            }
            yield createErrorStreamChunk(errorInfoFromPayload(raw, raw, attempt + 1));
            return;
          }

          try {
            yield options.format.decodeStreamChunk(raw, state);
          } catch (err) {
            closeAndInvalidateSessionSocket(session, socket);
            yield createErrorStreamChunk({
              kind: 'decode_error',
              rawChunk: raw,
              message: stringifyError(err),
              transport: 'websocket',
              phase: 'streaming',
              receivedServerEvent: true,
              attempt: attempt + 1,
              maxAttempts: OPENAI_RESPONSES_WS_MAX_REQUEST_ATTEMPTS,
              retryable: false,
            });
            return;
          }
        }
      } catch (error) {
        closeAndInvalidateSessionSocket(session, socket);
        if (isAbortError(options.signal, error)) throw error;
        const transportError = normalizeWebSocketTransportError(error);
        const canRetryWithinTransport = !sawServerEvent
          && attempt + 1 < OPENAI_RESPONSES_WS_MAX_REQUEST_ATTEMPTS
          && shouldRetryPreFirstEventWithinTransport(transportError);
        const normalized = withWebSocketAttemptContext(
          transportError,
          attempt + 1,
          sawServerEvent ? 'streaming' : 'awaiting_first_event',
          sawServerEvent,
          canRetryWithinTransport ? OPENAI_RESPONSES_WS_MAX_REQUEST_ATTEMPTS : attempt + 1,
        );
        if (canRetryWithinTransport) {
          shouldRetryFull = true;
          retryAfterTransportFailure = true;
          allowIncremental = false;
        } else {
          yield createErrorStreamChunk(errorInfoFromTransportError(normalized));
          return;
        }
      }

      if (shouldRetryFull) {
        if (retryAfterTransportFailure) await waitForReconnectDelay(attempt, options.signal);
        continue;
      }

      if (!completed || !responseId) {
        invalidateSessionState(session);
        return;
      }

      const responseInputItems = normalizeCompletedOutputItems(
        options.format,
        completedResponse,
        completedOutputItems,
        streamedReasoningSignatures,
      );
      const outputStateReliable = responseInputItems !== undefined
        && (responseInputItems.length > 0 || !sawSemanticOutput);
      if (!outputStateReliable) {
        invalidateSessionState(session);
        return;
      }

      // A terminal frame and an abnormal close can race. Never commit connection-local
      // continuation state after the socket lifecycle listener has already fenced it out.
      if (session.socket !== socket || !isSocketOpen(socket)) {
        invalidateSessionState(session);
        return;
      }

      updateSessionAfterComplete(session, prepared, responseId, responseInputItems);
      session.connectedAt = session.connectedAt ?? Date.now();
      return;
    }
  } finally {
    release();
  }
}

function sanitizeResponsesCreateBody(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) {
    throw new Error('OpenAI Responses WebSocket body must be a JSON object.');
  }
  const next: Record<string, unknown> = { ...body };
  delete next.type;
  delete next.stream;
  delete next.background;
  delete next.previous_response_id;
  // WebSocket continuation reuses connection-local state. Explicit HTTP prompt-cache
  // breakpoints mutate the last input item on every turn, which prevents stable
  // prefix matching; strip them for websocket transport and keep store=false.
  delete next.prompt_cache_options;
  next.store = false;
  next.input = Array.isArray(next.input) ? next.input.map(stripWebSocketOnlyInputFields) : [];
  return next;
}

function stripWebSocketOnlyInputFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripWebSocketOnlyInputFields);
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'prompt_cache_breakpoint') continue;
    result[key] = stripWebSocketOnlyInputFields(child);
  }
  return result;
}

function prepareCreatePayload(
  session: WebSocketSession,
  fullBody: Record<string, unknown>,
  allowIncremental: boolean,
): PreparedCreatePayload {
  const fullInputItems = Array.isArray(fullBody.input) ? [...fullBody.input] : [];
  const baseSignature = requestBaseSignature(fullBody);
  const prefixMismatch = session.serverInputItems ? prefixMismatchReason(fullInputItems, session.serverInputItems) : 'no_cached_server_input';
  const decisionReason = !allowIncremental
    ? 'incremental_disabled_for_retry'
    : !session.previousResponseId
      ? 'no_previous_response_id'
      : !session.serverInputItems
        ? 'no_cached_server_input'
        : session.baseSignature !== baseSignature
          ? 'base_signature_changed'
          : prefixMismatch
            ? prefixMismatch
            : fullInputItems.length <= session.serverInputItems.length
              ? 'no_new_input_suffix'
              : 'matched_prefix';
  const canUsePrevious = decisionReason === 'matched_prefix';

  const body: Record<string, unknown> = {
    ...fullBody,
    input: canUsePrevious ? fullInputItems.slice(session.serverInputItems!.length) : fullInputItems,
  };
  if (canUsePrevious) body.previous_response_id = session.previousResponseId;

  return {
    payload: { type: 'response.create', ...body, store: false },
    fullInputItems,
    baseSignature,
    decision: canUsePrevious ? 'incremental' : 'full',
    decisionReason,
    ...(canUsePrevious ? { usedPreviousResponseId: session.previousResponseId } : {}),
  };
}

function updateSessionAfterComplete(
  session: WebSocketSession,
  prepared: PreparedCreatePayload,
  responseId: string,
  responseInputItems: unknown[],
): void {
  session.previousResponseId = responseId;
  session.serverInputItems = [...prepared.fullInputItems, ...responseInputItems];
  session.baseSignature = prepared.baseSignature;
}

function normalizeCompletedOutputItems(
  format: FormatAdapter,
  completedResponse: unknown,
  completedOutputItems: readonly unknown[],
  streamedReasoningSignatures: readonly StreamedReasoningSignatureRecord[],
): unknown[] | undefined {
  const completedResponseItems = isPlainObject(completedResponse) && Array.isArray(completedResponse.output)
    ? completedResponse.output
    : [];
  const sourceItems = completedOutputItems.length > 0 ? completedOutputItems : completedResponseItems;
  if (sourceItems.length === 0) return [];

  const response = isPlainObject(completedResponse)
    ? { ...completedResponse, output: [...sourceItems] }
    : { output: [...sourceItems] };
  return encodeResponseAsInputItems(format, response, streamedReasoningSignatures);
}

function encodeResponseAsInputItems(
  format: FormatAdapter,
  rawResponse: unknown,
  streamedReasoningSignatures: readonly StreamedReasoningSignatureRecord[],
): unknown[] | undefined {
  const streamCompatibleResponse = normalizeCompletedResponseForStreamSignatures(rawResponse, streamedReasoningSignatures);
  const rawOutput = isPlainObject(streamCompatibleResponse) && Array.isArray(streamCompatibleResponse.output)
    ? streamCompatibleResponse.output
    : undefined;
  try {
    const decoded = format.decodeResponse(streamCompatibleResponse) as LLMResponse;
    const request: LLMRequest = { contents: [decoded.content] };
    const encoded = format.encodeRequest(request, false);
    if (isPlainObject(encoded) && Array.isArray(encoded.input)
      && (encoded.input.length > 0 || rawOutput?.length === 0)) {
      return encoded.input.map(stripWebSocketOnlyInputFields);
    }
  } catch {
    // Fall back to exact response.output_item.done items below.
  }

  if (rawOutput) return rawOutput.map(stripWebSocketOnlyInputFields);
  return undefined;
}

function captureCompletedOutputItem(
  payload: unknown,
  items: unknown[],
  keys: Map<string, number>,
): void {
  if (!isPlainObject(payload) || eventType(payload) !== 'response.output_item.done') return;
  const item = payload.item;
  if (!isPlainObject(item)) return;
  const itemId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
  const outputIndex = typeof payload.output_index === 'number' && Number.isInteger(payload.output_index)
    ? payload.output_index
    : undefined;
  const key = itemId !== undefined
    ? `item:${itemId}`
    : outputIndex !== undefined
      ? `output:${outputIndex}`
      : `ordinal:${items.length}`;
  const copied = { ...item };
  const existingIndex = keys.get(key);
  if (existingIndex === undefined) {
    keys.set(key, items.length);
    items.push(copied);
  } else {
    items[existingIndex] = copied;
  }
}

function isSemanticOutputEvent(type: string): boolean {
  return type.includes('output_text')
    || type.includes('reasoning')
    || type.includes('function_call')
    || type.includes('custom_tool_call');
}

function captureStreamedReasoningSignature(
  payload: unknown,
  records: StreamedReasoningSignatureRecord[],
): void {
  if (!isPlainObject(payload) || eventType(payload) !== 'response.output_item.done') return;
  const item = payload.item;
  if (!isPlainObject(item) || item.type !== 'reasoning') return;

  const itemId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
  const outputIndex = typeof payload.output_index === 'number' && Number.isInteger(payload.output_index)
    ? payload.output_index
    : undefined;
  const encryptedContent = typeof item.encrypted_content === 'string' && item.encrypted_content
    ? item.encrypted_content
    : undefined;
  const next: StreamedReasoningSignatureRecord = {
    ...(itemId ? { itemId } : {}),
    ...(outputIndex !== undefined ? { outputIndex } : {}),
    ...(encryptedContent ? { encryptedContent } : {}),
  };
  const existingIndex = records.findIndex((record) =>
    (itemId !== undefined && record.itemId === itemId)
    || (outputIndex !== undefined && record.outputIndex === outputIndex));
  if (existingIndex >= 0) records[existingIndex] = next;
  else records.push(next);
}

export function normalizeCompletedResponseForStreamSignatures(
  rawResponse: unknown,
  streamedReasoningSignatures: readonly StreamedReasoningSignatureRecord[],
): unknown {
  if (!isPlainObject(rawResponse) || !Array.isArray(rawResponse.output)) return rawResponse;

  let reasoningOrdinal = 0;
  const output = rawResponse.output.map((rawItem, outputIndex) => {
    if (!isPlainObject(rawItem) || rawItem.type !== 'reasoning') return rawItem;
    const itemId = typeof rawItem.id === 'string' && rawItem.id.trim() ? rawItem.id.trim() : undefined;
    const matched = streamedReasoningSignatures.find((record) => itemId !== undefined && record.itemId === itemId)
      ?? streamedReasoningSignatures.find((record) => record.outputIndex === outputIndex)
      ?? streamedReasoningSignatures[reasoningOrdinal];
    reasoningOrdinal += 1;

    const normalized: Record<string, unknown> = { ...rawItem };
    delete normalized.encrypted_content;
    if (matched?.encryptedContent) normalized.encrypted_content = matched.encryptedContent;
    return normalized;
  });

  return { ...rawResponse, output };
}

async function ensureOpenSocket(
  session: WebSocketSession,
  options: OpenAIResponsesWebSocketStreamOptions,
  forceNew: boolean,
): Promise<UndiciWebSocket> {
  const expired = isSessionExpired(session);
  const socketOpen = isSocketOpen(session.socket);
  if (forceNew || expired || !socketOpen) {
    closeSessionSocket(session);
    invalidateSessionState(session);
    const socket = await openSocket(options);
    session.socket = socket;
    session.connectedAt = Date.now();
    bindSessionSocketLifecycle(session, socket);
  }
  return session.socket!;
}

async function openSocket(options: OpenAIResponsesWebSocketStreamOptions): Promise<UndiciWebSocket> {
  const wsUrl = toWebSocketUrl(options.endpoint.webSocketUrl ?? options.url);
  const headers = webSocketHeaders(options.headers);
  const baseDispatcher = createWebSocketHandshakeDispatcher(options.endpoint.proxy);
  const dispatcher = webSocketNoCompressionDispatcher(baseDispatcher);
  const connectTimeoutMs = normalizePositiveTimeoutMs(
    options.connectTimeoutMs,
    OPENAI_RESPONSES_WS_CONNECT_TIMEOUT_MS,
    'connectTimeoutMs',
  );

  return new Promise<UndiciWebSocket>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(errorFromAbortSignal(options.signal));
      return;
    }

    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const ws = new UndiciWebSocket(wsUrl, {
      headers,
      dispatcher: dispatcher as never,
    });

    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = undefined;
      options.signal?.removeEventListener('abort', onAbort);
      ws.removeEventListener('open', onOpen as never);
      ws.removeEventListener('error', onError as never);
      ws.removeEventListener('close', onClose as never);
    };
    const disposeHandshakeDispatcher = (reason?: Error) => {
      void baseDispatcher.destroy(reason ?? null).catch(() => undefined);
    };
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // The upgraded WebSocket is detached from the handshake dispatcher. Destroying
      // the dedicated dispatcher here prevents idle/stale pool connections while the
      // upgraded socket remains usable for subsequent response.create messages.
      disposeHandshakeDispatcher();
      resolve(ws);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      const reason = error instanceof Error ? error : new Error(String(error));
      disposeHandshakeDispatcher(reason);
      try { ws.close(); } catch { /* noop */ }
      reject(error);
    };
    const onAbort = () => finishReject(errorFromAbortSignal(options.signal!));
    const onOpen = () => finishResolve();
    const onError = (event: Event) => finishReject(errorFromEvent(event, 'connecting', false));
    const onClose = (event: CloseEvent) => finishReject(
      new OpenAIResponsesWebSocketCloseError(event, 'connecting', false),
    );
    const onConnectTimeout = () => finishReject(timeoutError(
      `OpenAI Responses WebSocket connection timed out after ${connectTimeoutMs}ms`,
      'connecting',
      false,
    ));

    options.signal?.addEventListener('abort', onAbort, { once: true });
    ws.addEventListener('open', onOpen as never, { once: true });
    ws.addEventListener('error', onError as never, { once: true });
    ws.addEventListener('close', onClose as never, { once: true });
    connectTimer = setUnrefTimeout(onConnectTimeout, connectTimeoutMs);
  });
}

async function* sendCreateAndReadEvents(
  session: WebSocketSession,
  socket: UndiciWebSocket,
  payload: Record<string, unknown>,
  options: OpenAIResponsesWebSocketStreamOptions,
): AsyncGenerator<unknown> {
  const signal = options.signal;
  const queue = createAsyncQueue<unknown>(mergeOpenAIResponsesWebSocketEvents);
  const firstEventTimeoutMs = normalizePositiveTimeoutMs(
    options.firstEventTimeoutMs,
    OPENAI_RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS,
    'firstEventTimeoutMs',
  );
  const responseIdleTimeoutMs = normalizePositiveTimeoutMs(
    options.responseIdleTimeoutMs,
    OPENAI_RESPONSES_WS_RESPONSE_IDLE_TIMEOUT_MS,
    'responseIdleTimeoutMs',
  );
  const networkIdentityCheckIntervalMs = normalizePositiveTimeoutMs(
    options.networkIdentityCheckIntervalMs,
    OPENAI_RESPONSES_WS_NETWORK_CHECK_INTERVAL_MS,
    'networkIdentityCheckIntervalMs',
  );
  const expectedConnectionFingerprint = session.connectionFingerprint;
  let terminalSeen = false;
  let receivedAnyEvent = false;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let networkCheckTimer: ReturnType<typeof setInterval> | undefined;

  const clearResponseTimer = () => {
    if (responseTimer) clearTimeout(responseTimer);
    responseTimer = undefined;
  };
  const clearNetworkCheckTimer = () => {
    if (networkCheckTimer) clearInterval(networkCheckTimer);
    networkCheckTimer = undefined;
  };
  const onNetworkIdentityCheck = () => {
    if (terminalSeen) return;
    let currentConnectionFingerprint: string;
    try {
      currentConnectionFingerprint = webSocketConnectionFingerprintForOptions(options);
    } catch {
      return;
    }
    if (currentConnectionFingerprint === expectedConnectionFingerprint) return;
    clearResponseTimer();
    clearNetworkCheckTimer();
    const error = webSocketTransportError(
      'OpenAI Responses WebSocket local network changed',
      undefined,
      {
        code: 'network_changed',
        phase: receivedAnyEvent ? 'streaming' : 'awaiting_first_event',
        receivedServerEvent: receivedAnyEvent,
        retryable: true,
      },
    );
    closeAndInvalidateSessionSocket(session, socket);
    queue.fail(error);
  };
  const onResponseTimeout = () => {
    const error = receivedAnyEvent
      ? timeoutError(
        `OpenAI Responses WebSocket received no events for ${responseIdleTimeoutMs}ms`,
        'streaming',
        true,
      )
      : timeoutError(
        `OpenAI Responses WebSocket received no first event for ${firstEventTimeoutMs}ms`,
        'awaiting_first_event',
        false,
      );
    closeAndInvalidateSessionSocket(session, socket);
    queue.fail(error);
  };
  const armResponseTimer = () => {
    clearResponseTimer();
    const timeoutMs = receivedAnyEvent ? responseIdleTimeoutMs : firstEventTimeoutMs;
    responseTimer = setUnrefTimeout(onResponseTimeout, timeoutMs);
  };
  const cleanup = () => {
    clearResponseTimer();
    clearNetworkCheckTimer();
    signal?.removeEventListener('abort', onAbort);
    socket.removeEventListener('message', onMessage as never);
    socket.removeEventListener('error', onError as never);
    socket.removeEventListener('close', onClose as never);
  };
  const finish = () => {
    terminalSeen = true;
    clearResponseTimer();
    clearNetworkCheckTimer();
    queue.end();
  };
  const onAbort = () => {
    clearResponseTimer();
    const error = errorFromAbortSignal(signal!);
    closeAndInvalidateSessionSocket(session, socket);
    queue.fail(error);
  };
  const onMessage = (event: MessageEvent) => {
    receivedAnyEvent = true;
    armResponseTimer();
    const parsed = parseWebSocketData(event.data);
    if (!parsed.ok) {
      queue.push(createErrorPayload('stream_parse_error', parsed.error.message, event.data));
      finish();
      return;
    }
    queue.push(parsed.value);
    if (isTerminalEvent(parsed.value)) finish();
  };
  const onError = (event: Event) => {
    clearResponseTimer();
    queue.fail(errorFromEvent(
      event,
      receivedAnyEvent ? 'streaming' : 'awaiting_first_event',
      receivedAnyEvent,
    ));
  };
  const onClose = (event: CloseEvent) => {
    clearResponseTimer();
    if (terminalSeen) return;
    queue.fail(new OpenAIResponsesWebSocketCloseError(
      event,
      receivedAnyEvent ? 'streaming' : 'awaiting_first_event',
      receivedAnyEvent,
    ));
  };

  if (signal?.aborted) {
    closeAndInvalidateSessionSocket(session, socket);
    throw errorFromAbortSignal(signal);
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  socket.addEventListener('message', onMessage as never);
  socket.addEventListener('error', onError as never, { once: true });
  socket.addEventListener('close', onClose as never, { once: true });

  try {
    armResponseTimer();
    networkCheckTimer = setUnrefInterval(onNetworkIdentityCheck, networkIdentityCheckIntervalMs);
    sendResponseCreateOrThrow(socket, payload);
    for await (const item of queue) yield item;
  } finally {
    cleanup();
  }
}

function sessionFor(
  endpoint: EndpointConfig,
  url: string,
  headers: Record<string, string>,
  connectionFingerprint: string,
): WebSocketSession {
  const configured = endpoint.webSocketSessionKey?.trim();
  const key = configured || `stateless:${++statelessSessionCounter}:${url}:${headers.authorization ?? headers.Authorization ?? ''}`;
  let session = sessions.get(key);
  if (!session) {
    session = { key, connectionFingerprint };
    sessions.set(key, session);
  }
  return session;
}

function synchronizeSessionConnection(session: WebSocketSession, connectionFingerprint: string): void {
  if (session.connectionFingerprint === connectionFingerprint) return;
  closeSessionSocket(session);
  invalidateSessionState(session);
  session.connectionFingerprint = connectionFingerprint;
}

async function acquireSessionLock(session: WebSocketSession, signal?: AbortSignal): Promise<() => void> {
  const previous = session.lock?.catch(() => undefined) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const gate = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  session.lock = previous.then(() => gate);

  try {
    await waitWithAbort(previous, signal);
  } catch (error) {
    void previous.finally(releaseCurrent);
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
  };
}

function waitWithAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(errorFromAbortSignal(signal));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(errorFromAbortSignal(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => { cleanup(); resolve(); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function waitForReconnectDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(errorFromAbortSignal(signal));
  const delayMs = OPENAI_RESPONSES_WS_RECONNECT_DELAYS_MS[
    Math.min(attempt, OPENAI_RESPONSES_WS_RECONNECT_DELAYS_MS.length - 1)
  ]!;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(errorFromAbortSignal(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setUnrefTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, delayMs);
  });
}

function createAsyncQueue<T>(
  mergeQueued?: (previous: T, next: T) => T | undefined,
): AsyncIterable<T> & { push(value: T): void; end(): void; fail(error: unknown): void } {
  const items: QueuedMessage[] = [];
  const waiters: Array<(item: QueuedMessage) => void> = [];
  let closed = false;

  const emit = (item: QueuedMessage) => {
    const waiter = waiters.shift();
    if (waiter) waiter(item);
    else items.push(item);
  };

  return {
    push(value: T) {
      if (closed) return;
      if (mergeQueued && waiters.length === 0) {
        const previous = items[items.length - 1];
        if (previous && !previous.done && previous.error === undefined) {
          const mergedValue = mergeQueued(previous.value as T, value);
          if (mergedValue !== undefined) {
            previous.value = mergedValue;
            return;
          }
        }
      }
      emit({ value });
    },
    end() {
      if (closed) return;
      closed = true;
      emit({ done: true });
    },
    fail(error: unknown) {
      if (closed) return;
      closed = true;
      emit({ error });
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const item = items.shift() ?? await new Promise<QueuedMessage>((resolve) => waiters.push(resolve));
        if (item.error) throw item.error;
        if (item.done) return;
        yield item.value as T;
      }
    },
  };
}

const MERGEABLE_OPENAI_RESPONSES_WS_DELTA_EVENTS = new Set([
  'response.output_text.delta',
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
  'response.reasoning.delta',
  'response.function_call_arguments.delta',
]);
const OPENAI_RESPONSES_WS_DELTA_IDENTITY_FIELDS = [
  'response_id',
  'item_id',
  'output_index',
  'content_index',
  'summary_index',
] as const;

function isMergeableOpenAIResponsesWebSocketDelta(value: unknown): value is Record<string, unknown> & { delta: string } {
  if (!isPlainObject(value)) return false;
  return MERGEABLE_OPENAI_RESPONSES_WS_DELTA_EVENTS.has(eventType(value)) && typeof value.delta === 'string';
}

export function mergeOpenAIResponsesWebSocketEvents(previous: unknown, next: unknown): unknown | undefined {
  if (!isMergeableOpenAIResponsesWebSocketDelta(previous) || !isMergeableOpenAIResponsesWebSocketDelta(next)) return undefined;
  const type = eventType(previous);
  if (!type || type !== eventType(next)) return undefined;
  for (const field of OPENAI_RESPONSES_WS_DELTA_IDENTITY_FIELDS) {
    if (previous[field] !== next[field]) return undefined;
  }
  return {
    ...previous,
    ...next,
    delta: previous.delta + next.delta,
  };
}

function isSessionExpired(session: WebSocketSession): boolean {
  return session.connectedAt !== undefined && Date.now() - session.connectedAt >= OPENAI_RESPONSES_WS_MAX_AGE_MS;
}

function closeSessionSocket(session: WebSocketSession): void {
  const socket = session.socket;
  session.socket = undefined;
  session.connectedAt = undefined;
  if (!socket) return;
  try { socket.close(); } catch { /* noop */ }
}

function invalidateSessionState(session: WebSocketSession): void {
  session.previousResponseId = undefined;
  session.serverInputItems = undefined;
  session.baseSignature = undefined;
}

function closeAndInvalidateSessionSocket(session: WebSocketSession, socket: UndiciWebSocket): void {
  if (session.socket === socket) {
    closeSessionSocket(session);
    invalidateSessionState(session);
    return;
  }
  try { socket.close(); } catch { /* noop */ }
}

function isSocketOpen(socket: UndiciWebSocket | undefined): boolean {
  return !!socket && socket.readyState === UndiciWebSocket.OPEN;
}

function bindSessionSocketLifecycle(session: WebSocketSession, socket: UndiciWebSocket): void {
  const fenceSocket = () => invalidateSessionSocketIfCurrent(session, socket);
  socket.addEventListener('error', fenceSocket as never, { once: true });
  socket.addEventListener('close', fenceSocket as never, { once: true });
}

function invalidateSessionSocketIfCurrent(session: WebSocketSession, socket: UndiciWebSocket): void {
  if (session.socket !== socket) return;
  session.socket = undefined;
  session.connectedAt = undefined;
  invalidateSessionState(session);
}

function sendResponseCreateOrThrow(socket: UndiciWebSocket, payload: Record<string, unknown>): void {
  if (eventType(payload) !== 'response.create') {
    throw webSocketTransportError(
      'OpenAI Responses WebSocket first message must be response.create',
      undefined,
      { phase: 'sending_response_create', receivedServerEvent: false, retryable: false },
    );
  }
  if (!isSocketOpen(socket)) {
    throw webSocketTransportError(
      `OpenAI Responses WebSocket is not open before response.create (readyState=${socket.readyState})`,
      undefined,
      { phase: 'sending_response_create', receivedServerEvent: false, retryable: true },
    );
  }
  try {
    socket.send(JSON.stringify(payload));
  } catch (error) {
    const normalized = normalizeWebSocketTransportError(error);
    throw webSocketTransportError(
      normalized.message,
      normalized,
      { phase: 'sending_response_create', receivedServerEvent: false, retryable: true },
    );
  }
  // Undici WebSocket.send() silently returns when a close races with send. The
  // postcondition catches that no-op so the caller can fence and replay safely.
  if (!isSocketOpen(socket)) {
    throw webSocketTransportError(
      `OpenAI Responses WebSocket closed while sending response.create (readyState=${socket.readyState})`,
      undefined,
      { phase: 'sending_response_create', receivedServerEvent: false, retryable: true },
    );
  }
}

function webSocketHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (normalized === 'content-type' || normalized === 'content-length') continue;
    result[key] = value;
  }
  return result;
}

type WebSocketDispatcher = UndiciAgent | UndiciProxyAgent;
type WebSocketDispatch = WebSocketDispatcher['dispatch'];
interface WebSocketDispatchOnly {
  dispatch: WebSocketDispatch;
}

const noCompressionDispatcherCache = new WeakMap<object, WebSocketDispatchOnly>();

function createWebSocketHandshakeDispatcher(proxy?: LLMProxyOption): WebSocketDispatcher {
  const normalizedProxy = normalizeWebSocketProxy(proxy);
  if (!normalizedProxy) return new UndiciAgent();
  return new UndiciProxyAgent({
    uri: normalizedProxy.uri,
    ...(normalizedProxy.headers ? { headers: normalizedProxy.headers } : {}),
    requestTls: { rejectUnauthorized: false },
  });
}

function webSocketNoCompressionDispatcher(base: WebSocketDispatcher): WebSocketDispatchOnly {
  const cacheKey = base as object;
  const cached = noCompressionDispatcherCache.get(cacheKey);
  if (cached) return cached;

  const dispatch: WebSocketDispatch = (options, handler) => {
    const headers = stripWebSocketCompressionHeader(options.headers);
    return base.dispatch({ ...options, headers: headers as typeof options.headers }, handler);
  };
  const wrapped = { dispatch };
  noCompressionDispatcherCache.set(cacheKey, wrapped);
  return wrapped;
}

function stripWebSocketCompressionHeader(headers: unknown): unknown {
  if (Array.isArray(headers)) {
    const result = [...headers];
    for (let index = result.length - 2; index >= 0; index -= 2) {
      if (String(result[index]).toLowerCase() === 'sec-websocket-extensions') {
        result.splice(index, 2);
      }
    }
    return result;
  }
  if (!headers || typeof headers !== 'object') return headers;
  const result: Record<string, unknown> = { ...(headers as Record<string, unknown>) };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'sec-websocket-extensions') delete result[key];
  }
  return result;
}

function normalizeWebSocketProxy(proxy?: LLMProxyOption): NormalizedWebSocketProxy | undefined {
  if (!proxy) return undefined;
  const uri = (typeof proxy === 'string' ? proxy : proxy.url).trim();
  if (!uri) return undefined;
  const headers = typeof proxy === 'string' || !proxy.headers || Object.keys(proxy.headers).length === 0
    ? undefined
    : proxy.headers;
  const sortedHeaders = headers
    ? Object.fromEntries(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)))
    : undefined;
  return {
    uri,
    ...(headers ? { headers } : {}),
    cacheKey: JSON.stringify({ uri, headers: sortedHeaders }),
  };
}

function webSocketConnectionFingerprintForOptions(options: OpenAIResponsesWebSocketStreamOptions): string {
  return webSocketConnectionFingerprint(
    options.endpoint,
    options.url,
    options.headers,
    resolveNetworkIdentityFingerprint(options.networkIdentityFingerprint),
  );
}

function resolveNetworkIdentityFingerprint(override?: string | (() => string)): string {
  const overrideValue = typeof override === 'function' ? override() : override;
  const normalizedOverride = overrideValue?.trim();
  if (normalizedOverride) return normalizedOverride;
  let addresses: string[];
  try {
    addresses = Object.entries(networkInterfaces())
      .flatMap(([name, records]) => (records ?? [])
        .filter((record) => !record.internal)
        .map((record) => [
          name,
          String(record.family),
          record.address,
          record.netmask,
          record.cidr ?? '',
          String(record.scopeid ?? ''),
        ].join(':')))
      .sort();
  } catch {
    addresses = ['network-interfaces-unavailable'];
  }
  return createHash('sha256')
    .update(addresses.length > 0 ? addresses.join('\n') : 'no-external-network')
    .digest('hex');
}

function webSocketConnectionFingerprint(
  endpoint: EndpointConfig,
  url: string,
  headers: Record<string, string>,
  networkIdentityFingerprint: string,
): string {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(webSocketHeaders(headers))
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const identity = stableStringify({
    url: toWebSocketUrl(endpoint.webSocketUrl ?? url),
    headers: normalizedHeaders,
    proxy: normalizeWebSocketProxy(endpoint.proxy)?.cacheKey ?? null,
    networkIdentityFingerprint,
  });
  return createHash('sha256').update(identity).digest('hex');
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  return parsed.toString();
}

function requestBaseSignature(body: Record<string, unknown>): string {
  const { input: _input, previous_response_id: _previous, stream: _stream, background: _background, type: _type, ...rest } = body;
  void _input; void _previous; void _stream; void _background; void _type;
  return stableStringify(rest);
}

function prefixMismatchReason(items: unknown[], prefix: unknown[]): string | undefined {
  if (prefix.length > items.length) return `cached_prefix_longer:${prefix.length}>${items.length}`;
  for (let index = 0; index < prefix.length; index += 1) {
    if (stableStringify(items[index]) !== stableStringify(prefix[index])) return `input_prefix_mismatch_at:${index}`;
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function parseWebSocketData(data: unknown): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    if (typeof data === 'string') return { ok: true, value: JSON.parse(data) };
    if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
      return { ok: true, value: JSON.parse(Buffer.concat(data).toString('utf8')) };
    }
    if (data instanceof ArrayBuffer) return { ok: true, value: JSON.parse(new TextDecoder().decode(data)) };
    if (ArrayBuffer.isView(data)) return { ok: true, value: JSON.parse(new TextDecoder().decode(data)) };
    return { ok: true, value: JSON.parse(String(data)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function isTerminalEvent(value: unknown): boolean {
  const type = eventType(value);
  return type === 'response.completed'
    || type === 'response.failed'
    || type === 'response.incomplete'
    || type === 'response.cancelled'
    || type === 'error'
    || type.endsWith('.failed')
    || type.endsWith('.incomplete');
}

function completedResponseFromPayload(value: unknown): unknown | undefined {
  if (!isPlainObject(value)) return undefined;
  const type = eventType(value);
  if (type !== 'response.completed') return undefined;
  return isPlainObject(value.response) ? value.response : value;
}

function responseIdFromPayload(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.id === 'string' && value.id.startsWith('resp_')) return value.id;
  if (typeof value.response_id === 'string') return value.response_id;
  const response = value.response;
  if (isPlainObject(response) && typeof response.id === 'string') return response.id;
  return undefined;
}

function isRecoverableContinuationError(value: unknown): boolean {
  const code = errorCode(value);
  return code === 'previous_response_not_found'
    || code === 'websocket_connection_limit_reached';
}

function errorCode(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.code === 'string' && value.code.trim()) return value.code.trim();
  const error = value.error;
  if (isPlainObject(error)) {
    if (typeof error.code === 'string' && error.code.trim()) return error.code.trim();
    if (typeof error.type === 'string' && error.type.trim()) return error.type.trim();
  }
  const response = value.response;
  return isPlainObject(response) ? errorCode(response) : undefined;
}

function isProviderErrorPayload(payload: unknown): boolean {
  if (!isPlainObject(payload)) return false;
  const type = eventType(payload);
  if (type === 'error' || type.includes('error') || type.includes('failed')
    || type.includes('incomplete') || type.includes('cancelled')) return true;
  if ('error' in payload && payload.error !== null && payload.error !== undefined) return true;
  const response = payload.response;
  if (isPlainObject(response)) {
    const status = typeof response.status === 'string' ? response.status.toLowerCase() : '';
    if ((status === 'failed' || status === 'incomplete' || status === 'cancelled') && (response.error || response.incomplete_details)) return true;
  }
  return false;
}

function errorInfoFromPayload(payload: unknown, rawChunk: unknown, attempt: number): LLMRawErrorInfo {
  const record = isPlainObject(payload) ? payload : { data: payload };
  const status = errorStatus(record);
  const code = errorCode(record);
  const message = nestedPayloadMessage(record);
  const retryable = providerErrorRetryability(record);
  return {
    kind: 'stream_error',
    rawChunk,
    event: eventType(payload) || undefined,
    transport: 'websocket',
    phase: 'streaming',
    receivedServerEvent: true,
    attempt,
    maxAttempts: OPENAI_RESPONSES_WS_MAX_REQUEST_ATTEMPTS,
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(isPlainObject(record.headers) ? { headers: record.headers as Record<string, string> } : {}),
    ...(message ? { message } : {}),
    rawBody: payload,
  };
}

function nestedPayloadMessage(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const direct = value.message;
  if (typeof direct === 'string' && direct.trim() && !isGenericErrorLabel(direct)) return direct.trim();
  const error = value.error;
  if (isPlainObject(error)) {
    const message = error.message;
    if (typeof message === 'string' && message.trim() && !isGenericErrorLabel(message)) return message.trim();
  }
  const response = value.response;
  if (isPlainObject(response)) return nestedPayloadMessage(response);
  return undefined;
}

function numericField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorStatus(value: unknown): number | undefined {
  if (!isPlainObject(value)) return undefined;
  const direct = numericField(value.status) ?? numericField(value.status_code);
  if (direct !== undefined) return direct;
  const error = value.error;
  if (isPlainObject(error)) {
    const nested = errorStatus(error);
    if (nested !== undefined) return nested;
  }
  const response = value.response;
  return isPlainObject(response) ? errorStatus(response) : undefined;
}

function providerErrorRetryability(value: unknown): boolean | undefined {
  const code = errorCode(value)?.toLowerCase();
  if (code) {
    if (OPENAI_RESPONSES_WS_RETRYABLE_PROVIDER_ERROR_CODES.has(code)) return true;
    if (OPENAI_RESPONSES_WS_NON_RETRYABLE_PROVIDER_ERROR_CODES.has(code)) return false;
  }
  const status = errorStatus(value);
  if (status === undefined) return undefined;
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return true;
  if (status >= 400 && status < 500) return false;
  return undefined;
}

function isGenericErrorLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'stream_error'
    || normalized === 'upstream_error'
    || normalized === 'http_error'
    || normalized === 'response_error'
    || normalized === 'decode_error'
    || normalized === 'stream_read_error'
    || normalized === 'stream_parse_error'
    || normalized === 'llm_error';
}

function createErrorPayload(kind: LLMRawErrorInfo['kind'], message: string, rawChunk: unknown): Record<string, unknown> {
  return {
    type: 'error',
    error: { code: kind, message },
    rawChunk,
  };
}

function createErrorStreamChunk(error: LLMRawErrorInfo): LLMStreamChunk {
  return {
    error,
    rawChunk: error.rawChunk ?? error.rawBody ?? error.bodyText ?? error.data,
  };
}

function eventType(value: unknown): string {
  if (!isPlainObject(value)) return '';
  return typeof value.type === 'string'
    ? value.type
    : typeof value.event === 'string'
      ? value.event
      : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizePositiveTimeoutMs(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
  return Math.max(1, Math.floor(value));
}

function setUnrefTimeout(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, timeoutMs);
  timer.unref();
  return timer;
}

function setUnrefInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval> {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return timer;
}

function timeoutError(
  message: string,
  phase: OpenAIResponsesWebSocketPhase,
  receivedServerEvent: boolean,
): Error {
  const error = new Error(message) as Error & OpenAIResponsesWebSocketErrorMetadata;
  error.name = 'TimeoutError';
  error.transport = 'websocket';
  error.phase = phase;
  error.receivedServerEvent = receivedServerEvent;
  error.retryable = true;
  return error;
}

function webSocketTransportError(
  message: string,
  cause?: unknown,
  metadata: OpenAIResponsesWebSocketErrorMetadata = { retryable: true },
): Error {
  const error = new Error(message) as Error & OpenAIResponsesWebSocketErrorMetadata & { cause?: unknown };
  error.name = 'WebSocketTransportError';
  error.transport = 'websocket';
  if (metadata.phase !== undefined) error.phase = metadata.phase;
  if (metadata.code !== undefined) error.code = metadata.code;
  if (metadata.receivedServerEvent !== undefined) error.receivedServerEvent = metadata.receivedServerEvent;
  error.retryable = metadata.retryable ?? true;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function normalizeWebSocketTransportError(error: unknown): Error {
  if (error instanceof Error && error.message.trim()) return error;
  return webSocketTransportError('OpenAI Responses WebSocket network connection lost', error);
}

function withWebSocketAttemptContext(
  error: Error,
  attempt: number,
  phase: OpenAIResponsesWebSocketPhase,
  receivedServerEvent: boolean,
  maxAttempts = OPENAI_RESPONSES_WS_MAX_REQUEST_ATTEMPTS,
): Error {
  const contextual = error as Error & OpenAIResponsesWebSocketErrorMetadata;
  contextual.transport = 'websocket';
  contextual.phase ??= phase;
  contextual.receivedServerEvent ??= receivedServerEvent;
  contextual.attempt = attempt;
  contextual.maxAttempts = maxAttempts;
  contextual.retryable ??= isRetryablePreFirstEventTransportError(error);
  return contextual;
}

function errorInfoFromTransportError(error: Error): LLMRawErrorInfo {
  const metadata = error as Error & OpenAIResponsesWebSocketErrorMetadata;
  return {
    kind: 'stream_read_error',
    message: stringifyError(error),
    transport: 'websocket',
    ...(metadata.phase ? { phase: metadata.phase } : {}),
    ...(metadata.code ? { code: metadata.code } : {}),
    ...(metadata.closeCode !== undefined ? { closeCode: metadata.closeCode } : {}),
    ...(metadata.closeReason ? { closeReason: metadata.closeReason } : {}),
    ...(metadata.closeWasClean !== undefined ? { closeWasClean: metadata.closeWasClean } : {}),
    ...(metadata.receivedServerEvent !== undefined ? { receivedServerEvent: metadata.receivedServerEvent } : {}),
    ...(metadata.attempt !== undefined ? { attempt: metadata.attempt } : {}),
    ...(metadata.maxAttempts !== undefined ? { maxAttempts: metadata.maxAttempts } : {}),
    ...(metadata.retryable !== undefined ? { retryable: metadata.retryable } : {}),
  };
}

function isRetryableWebSocketClose(code: number, reason: string): boolean {
  if (code === 1008) {
    return reason.toLowerCase().includes('missing first response.create message');
  }
  return OPENAI_RESPONSES_WS_RETRYABLE_CLOSE_CODES.has(code);
}

function shouldRetryPreFirstEventWithinTransport(error: Error): boolean {
  // Slow deadlines already consumed enough wall-clock time. Let the caller's
  // retry/backoff policy own the next attempt instead of multiplying waits here.
  return error.name !== 'TimeoutError' && isRetryablePreFirstEventTransportError(error);
}

function isRetryablePreFirstEventTransportError(error: Error): boolean {
  const metadata = error as Error & OpenAIResponsesWebSocketErrorMetadata & { code?: unknown };
  if (typeof metadata.retryable === 'boolean') return metadata.retryable;
  if (typeof metadata.closeCode === 'number') {
    return isRetryableWebSocketClose(metadata.closeCode, metadata.closeReason ?? '');
  }
  if (error.name === 'TimeoutError' || error.name === 'WebSocketTransportError') return true;
  const code = typeof metadata.code === 'string' ? metadata.code.toUpperCase() : '';
  return code === 'ECONNABORTED'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'EHOSTDOWN'
    || code === 'EHOSTUNREACH'
    || code === 'ENETDOWN'
    || code === 'ENETRESET'
    || code === 'ENETUNREACH'
    || code === 'EPIPE'
    || code === 'ETIMEDOUT'
    || code === 'EAI_AGAIN';
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function errorFromEvent(
  event: Event,
  phase: OpenAIResponsesWebSocketPhase,
  receivedServerEvent: boolean,
): Error {
  const maybe = event as Event & { error?: unknown; message?: unknown };
  if (maybe.error !== undefined) {
    const normalized = normalizeWebSocketTransportError(maybe.error);
    return webSocketTransportError(
      normalized.message,
      normalized,
      { phase, receivedServerEvent, retryable: true },
    );
  }
  if (typeof maybe.message === 'string' && maybe.message.trim()) {
    return webSocketTransportError(
      maybe.message.trim(),
      undefined,
      { phase, receivedServerEvent, retryable: true },
    );
  }
  return webSocketTransportError(
    event.type === 'error'
      ? 'OpenAI Responses WebSocket network connection lost'
      : `OpenAI Responses WebSocket ${event.type || 'transport'} event`,
    undefined,
    { phase, receivedServerEvent, retryable: true },
  );
}

function errorFromAbortSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason ? String(reason) : 'OpenAI Responses WebSocket request aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}
