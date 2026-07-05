import {
  DELETE_TOOL_NAME,
  EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  READ_AGENT_ANSWER_TOOL_NAME,
  SUBMIT_AGENT_ANSWER_TOOL_NAME,
  SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TRANSFER_TOOL_NAME,
  WRITE_TOOL_NAME,
  type ToolCallStatus
} from '../../../../shared/protocol';

type JsonRecord = Record<string, unknown>;

interface EnvelopeResult {
  ok?: boolean;
  output: unknown;
}

export function simplifyToolResponseForModel(toolName: string, status: ToolCallStatus, rawResponse: unknown): JsonRecord {
  const envelope = unwrapEnvelope(rawResponse);
  const value = envelope ? envelope.output : rawResponse;
  const ok = envelope?.ok ?? (status !== 'error');
  const isError = !ok || status === 'error';

  switch (toolName) {
    case 'shell':
    case 'bash':
      return simplifyCommandResponse(value, status);
    case READ_TOOL_NAME:
      return isError ? errorResponse(value) : simplifyReadResponse(value);
    case WRITE_TOOL_NAME:
      return isError ? errorResponse(value) : simplifyWriteResponse(value);
    case EDIT_TOOL_NAME:
      return simplifyEditResponse(value, status);
    case DELETE_TOOL_NAME:
      return simplifyDeleteResponse(value);
    case TRANSFER_TOOL_NAME:
      return simplifyTransferResponse(value);
    case TASK_LIST_TOOL_NAME:
      return isError ? errorResponse(value) : { ok: true };
    case SWITCH_WORK_ENVIRONMENT_TOOL_NAME:
      return isError ? errorResponse(value) : simplifySwitchWorkEnvironmentResponse(value);
    case 'run_agent':
      return isError ? errorResponse(value) : simplifyRunAgentResponse(value);
    case READ_AGENT_ANSWER_TOOL_NAME:
      return isError ? errorResponse(value) : simplifyReadAgentAnswerResponse(value);
    case SUBMIT_AGENT_ANSWER_TOOL_NAME:
      return isError ? errorResponse(value) : simplifySubmitAgentAnswerResponse(value);
    default:
      if (isError) return errorResponse(value);
      return simplifyGenericSuccess(value);
  }
}

function unwrapEnvelope(value: unknown): EnvelopeResult | undefined {
  const record = asRecord(value);
  if (!record || !('output' in record)) return undefined;
  if (typeof record.ok === 'boolean') return { ok: record.ok, output: record.output };
  return undefined;
}

function simplifyCommandResponse(value: unknown, status: ToolCallStatus): JsonRecord {
  const record = asRecord(value);
  if (!record) return simplifyGenericSuccess(value);

  const stdout = nonEmptyString(record.stdout);
  const stderr = nonEmptyString(record.stderr);
  const exitCode = numberValue(record.exitCode);
  const killed = record.killed === true;
  const runStatus = stringValue(record.status);
  const processId = nonEmptyString(record.processId);
  const running = record.running === true;
  const droppedChars = numberValue(record.droppedChars);
  // 后台/运行中不算异常；running 时 exitCode 是占位 0，不作为异常判据。
  const backgrounded = runStatus === 'running' || runStatus === 'exited' || runStatus === 'killed' || runStatus === 'not_found';
  const abnormal = status !== 'success' || (!running && killed) || (!backgrounded && exitCode !== undefined && exitCode !== 0) || !!stderr;

  const result: JsonRecord = {};
  if (stdout) result.stdout = stdout;
  if (stderr) result.stderr = stderr;
  if (processId) result.processId = processId;
  // 展示非 completed 的状态，便于模型判断是否需要继续 poll / 已结束。
  if (runStatus && runStatus !== 'completed') result.status = runStatus;
  if (running) result.running = true;
  if (droppedChars !== undefined && droppedChars > 0) result.droppedChars = droppedChars;
  if (abnormal && exitCode !== undefined) result.exitCode = exitCode;
  if (killed && !running) result.killed = true;
  return withOkFallback(result, status);
}

function simplifyReadResponse(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) return simplifyGenericSuccess(value);
  // inlineData 模式：response 只保留 mimeType 和 sizeBytes，文件名/路径已在 parts 的 inlineData 中
  if (record.mimeType !== undefined && record.sizeBytes !== undefined && record.content === undefined && record.totalLines === undefined) {
    return withOkFallback(pickDefined({
      mimeType: stringValue(record.mimeType),
      sizeBytes: numberValue(record.sizeBytes)
    }), 'success');
  }
  return withOkFallback(pickDefined({
    totalLines: numberValue(record.totalLines),
    content: stringValue(record.content)
  }), 'success');
}

function simplifyWriteResponse(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) return simplifyGenericSuccess(value);
  return withOkFallback(pickDefined({
    path: stringValue(record.path)
  }), 'success');
}

function simplifyEditResponse(value: unknown, status: ToolCallStatus): JsonRecord {
  const record = asRecord(value);
  if (!record) return status === 'error' ? errorResponse(value) : simplifyGenericSuccess(value);
  const failed = numberValue(record.failed);
  const hasProblem = status !== 'success' || (failed !== undefined && failed > 0);
  if (!hasProblem) return { ok: true };
  const result = pickDefined({
    path: stringValue(record.path),
    summary: editProblemSummary(record)
  });
  return withOkFallback(result, status);
}

function simplifyDeleteResponse(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) return simplifyGenericSuccess(value);
  const paths = compactDeletePathStatusItems(record.paths);
  const hasFailure = paths.some((item) => item.success === false);
  if (!hasFailure) return { ok: true };
  return withOkFallback(pickDefined({
    paths: paths.length > 0 ? paths : undefined
  }), 'error');
}

function simplifyTransferResponse(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) return simplifyGenericSuccess(value);
  const entries = compactTransferEntries(record.results);
  return withOkFallback(pickDefined({
    results: entries.length > 0 ? entries : undefined
  }), 'success');
}

function simplifySwitchWorkEnvironmentResponse(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) return simplifyGenericSuccess(value);
  const environment = asRecord(record.workEnvironment);
  return withOkFallback(pickDefined({
    workEnvironmentId: stringValue(environment?.id),
    name: stringValue(environment?.name)
  }), 'success');
}

function simplifyRunAgentResponse(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) return simplifyGenericSuccess(value);
  const status = stringValue(record.status);
  if (status === 'async_launched') {
    return withOkFallback(pickDefined({ answerBridgeId: stringValue(record.answerBridgeId) }), 'success');
  }
  return withOkFallback(pickDefined({
    answerBridgeId: stringValue(record.answerBridgeId),
    title: stringValue(record.title),
    content: stringValue(record.content)
  }), 'success');
}

function simplifyReadAgentAnswerResponse(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) return simplifyGenericSuccess(value);
  // read_agent_answer 用内联 ok:false 表达 running / interrupted / not_found；这里保留 ok/status/agentId/error，
  // 否则模型只会看到空的 { ok: true }，无法区分“子对话还在跑”“已中断可续”“answerBridgeId 不存在”。
  if (record.ok === false) {
    return pickDefined({
      ok: false,
      status: stringValue(record.status),
      answerBridgeId: stringValue(record.answerBridgeId),
      agentId: stringValue(record.agentId),
      error: stringValue(record.error)
    });
  }
  return withOkFallback(pickDefined({
    title: stringValue(record.title),
    content: stringValue(record.content)
  }), 'success');
}

function simplifySubmitAgentAnswerResponse(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) return simplifyGenericSuccess(value);
  return withOkFallback(pickDefined({ answerBridgeId: stringValue(record.answerBridgeId) }), 'success');
}

function simplifyGenericSuccess(value: unknown): JsonRecord {
  if (value === undefined || value === null || value === '') return { ok: true };
  if (typeof value === 'string') return value.trim() ? { output: value } : { ok: true };
  if (typeof value === 'number' || typeof value === 'boolean') return { output: value };
  if (Array.isArray(value)) return value.length > 0 ? { output: value } : { ok: true };

  const record = asRecord(value);
  if (!record) return { output: String(value) };
  const simplified = stripGenericNoise(record);
  return withOkFallback(simplified, 'success');
}

function errorResponse(value: unknown): JsonRecord {
  if (typeof value === 'string') return { error: value };
  const record = asRecord(value);
  if (!record) return { error: String(value) };
  const output = 'output' in record ? record.output : undefined;
  if (typeof output === 'string') return { error: output };
  const outputRecord = asRecord(output);
  const base = outputRecord ? stripGenericNoise(outputRecord) : stripGenericNoise(record);
  if (!('error' in base)) {
    const message = stringValue(record.error) ?? stringValue(outputRecord?.error) ?? stringValue(outputRecord?.summary) ?? stringValue(record.summary);
    if (message) base.error = message;
  }
  if (!('ok' in base)) base.ok = false;
  return base;
}

function stripGenericNoise(record: JsonRecord): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'ok' && value === true) continue;
    if (key === 'success' && value === true) continue;
    if (key === 'killed' && value === false) continue;
    if (key === 'exitCode' && value === 0) continue;
    if (key === 'stderr' && value === '') continue;
    if (key === 'stdout' && value === '') continue;
    if (key === 'command') continue;
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

function compactDeletePathStatusItems(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  const items: JsonRecord[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const path = stringValue(record.path);
    const success = booleanValue(record.success);
    if (!path || success === undefined) continue;
    items.push({ path, success });
  }
  return items;
}


function compactTransferEntries(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  const items: JsonRecord[] = [];
  for (let position = 0; position < value.length; position += 1) {
    const item = value[position];
    const record = asRecord(item);
    if (!record) continue;
    const compact = pickDefined({ index: numberValue(record.index) ?? position, error: stringValue(record.error) });
    items.push(compact);
  }
  return items;
}

function editProblemSummary(record: JsonRecord): string | undefined {
  const failed = failedEditResults(record.results);
  if (failed.length > 0) return failed.join('；');
  return stringValue(record.summary) ?? stringValue(record.error);
}

function failedEditResults(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (let position = 0; position < value.length; position += 1) {
    const record = asRecord(value[position]);
    if (!record || record.success !== false) continue;
    const index = numberValue(record.index);
    const displayIndex = (index ?? position) + 1;
    const error = stringValue(record.error) ?? stringValue(asRecord(record.fallback)?.message) ?? '未能应用';
    lines.push(`第 ${displayIndex} 处 diff 失败：${error}`);
  }
  return lines;
}

function withOkFallback(record: JsonRecord, status: ToolCallStatus): JsonRecord {
  if (Object.keys(record).length > 0) return record;
  return status === 'error' ? { ok: false } : { ok: true };
}

function pickDefined(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
