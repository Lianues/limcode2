import type {
  LlmUsageMetadataRecord,
  MessageRecord,
  MsgRole,
  MsgStatus
} from '@shared/protocol';

const hasOwn = Object.prototype.hasOwnProperty;

const TOTAL_TOKEN_KEYS = ['totalTokenCount', 'total_tokens', 'totalTokens'] as const;
const INPUT_TOKEN_KEYS = ['promptTokenCount', 'prompt_tokens', 'input_tokens', 'inputTokens'] as const;
const OUTPUT_TOKEN_KEYS = ['candidatesTokenCount', 'completion_tokens', 'output_tokens', 'outputTokens'] as const;
const REASONING_TOKEN_KEYS = ['thoughtsTokenCount', 'reasoning_tokens'] as const;
const CACHED_TOKEN_KEYS = ['cachedContentTokenCount', 'cached_content_token_count', 'cached_tokens'] as const;

export interface NormalizedTokenUsage {
  total?: number;
  input?: number;
  /** 模型输出 token，优先按 total - input 计算，因此会包含思考/推理 token。 */
  output?: number;
  reasoning?: number;
  cached?: number;
  totalEstimated?: boolean;
  sourceEstimated?: boolean;
}

export type TokenUsageEntryKind = 'system' | 'message';

export interface TokenUsageMessageEntry {
  id: string;
  kind: TokenUsageEntryKind;
  index: number;
  messageId?: string;
  messageSeq?: number;
  label?: string;
  role?: MsgRole;
  status?: MsgStatus;
  createdAt?: number;
  total: number;
  input?: number;
  output?: number;
  reasoning?: number;
  tool?: number;
  cached?: number;
  totalEstimated: boolean;
  sourceEstimated: boolean;
  fixedRatio?: boolean;
  ratio: number;
}

export function buildTokenUsageMessages(messages: MessageRecord[]): TokenUsageMessageEntry[] {
  const sortedMessages = [...messages].sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const normalEntries: Array<Omit<TokenUsageMessageEntry, 'ratio'>> = [];
  let firstModelUsage: { usage: NormalizedTokenUsage; floorNumber: number } | undefined;
  let userInputBeforeFirstModel = 0;
  let previousModelInput: number | undefined;
  let userInputSincePreviousModel = 0;

  sortedMessages.forEach((message, index) => {
    const floorNumber = index + 1;
    const usage = message.usageMetadata ? normalizeTokenUsage(message.usageMetadata) : undefined;
    if (!usage) return;

    if (message.role === 'model' && usage.total !== undefined && firstModelUsage === undefined) {
      firstModelUsage = { usage, floorNumber };
    }

    const userInput = message.role === 'user' ? usage.input ?? usage.total ?? 0 : 0;
    if (firstModelUsage === undefined) userInputBeforeFirstModel += userInput;

    let tool: number | undefined;
    if (message.role === 'model') {
      tool = toolTokensFromInputDelta(usage.input, previousModelInput, userInputSincePreviousModel);
      if (usage.input !== undefined) previousModelInput = usage.input;
      userInputSincePreviousModel = 0;
    } else {
      userInputSincePreviousModel += userInput;
    }

    const entry = messageUsageEntry(message, floorNumber, usage, tool);
    if (entry) normalEntries.push(entry);
  });

  const maxNormalTotal = Math.max(0, ...normalEntries.map((entry) => entry.total));
  const systemEntry = buildSystemPromptEntry(firstModelUsage, userInputBeforeFirstModel);
  const entries = systemEntry ? [systemEntry, ...normalEntries] : normalEntries;

  return entries.map((entry) => ({
    ...entry,
    ratio: entry.fixedRatio ? 1 : maxNormalTotal > 0 ? entry.total / maxNormalTotal : 0
  }));
}

export function normalizeTokenUsage(usage: LlmUsageMetadataRecord): NormalizedTokenUsage {
  const input = usageNumber(usage, INPUT_TOKEN_KEYS);
  const rawOutput = usageNumber(usage, OUTPUT_TOKEN_KEYS);
  const reasoning = usageNumber(usage, REASONING_TOKEN_KEYS);
  const cached = usageNumber(usage, CACHED_TOKEN_KEYS);
  const explicitTotal = usageNumber(usage, TOTAL_TOKEN_KEYS);
  const output = outputTokensIncludingReasoning(input, rawOutput, reasoning, explicitTotal);
  const fallbackTotal = explicitTotal === undefined ? sumDefined([input, output]) : undefined;
  const sourceEstimated = usage.estimated === true || usage.tokenEstimator === 'tokenx';

  return {
    ...(explicitTotal !== undefined ? { total: explicitTotal } : fallbackTotal !== undefined ? { total: fallbackTotal, totalEstimated: true } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cached !== undefined ? { cached } : {}),
    ...(sourceEstimated ? { sourceEstimated: true } : {})
  };
}

function outputTokensIncludingReasoning(input: number | undefined, rawOutput: number | undefined, reasoning: number | undefined, total: number | undefined): number | undefined {
  if (total !== undefined && input !== undefined) {
    return Math.max(0, total - input);
  }

  return sumDefined([rawOutput, reasoning]);
}

export function formatTokenNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatCompactTokenNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${formatScaledNumber(value, 1_000_000_000)}b`;
  if (abs >= 1_000_000) return `${formatScaledNumber(value, 1_000_000)}m`;
  if (abs >= 1_000) return `${formatScaledNumber(value, 1_000)}k`;
  return formatTokenNumber(value);
}

export function formatFloorNumber(index: number): string {
  return String(index).padStart(2, '0');
}

function messageUsageEntry(message: MessageRecord, floorNumber: number, usage: NormalizedTokenUsage, tool: number | undefined): Omit<TokenUsageMessageEntry, 'ratio'> | undefined {
  const total = totalForMessage(message.role, usage, tool);
  if (total === undefined || total <= 0) return undefined;

  const usageParts = usagePartsForMessage(message.role, usage, tool);
  return {
    id: message.id,
    kind: 'message',
    index: floorNumber,
    messageId: message.id,
    messageSeq: message.seq,
    role: message.role,
    status: message.status,
    createdAt: message.createdAt,
    total,
    ...(usageParts.input !== undefined ? { input: usageParts.input } : {}),
    ...(usageParts.output !== undefined ? { output: usageParts.output } : {}),
    ...(usageParts.reasoning !== undefined ? { reasoning: usageParts.reasoning } : {}),
    ...(usageParts.tool !== undefined ? { tool: usageParts.tool } : {}),
    totalEstimated: usage.totalEstimated === true,
    sourceEstimated: usage.sourceEstimated === true
  };
}

function totalForMessage(role: MsgRole, usage: NormalizedTokenUsage, tool: number | undefined): number | undefined {
  if (role === 'user') return usage.input ?? usage.total;
  const outputWithReasoning = usage.output ?? usage.reasoning;
  return sumDefined([outputWithReasoning, tool]) ?? nonInputFromTotal(usage) ?? usage.total;
}

function usagePartsForMessage(role: MsgRole, usage: NormalizedTokenUsage, tool: number | undefined): Pick<TokenUsageMessageEntry, 'input' | 'output' | 'reasoning' | 'tool'> {
  if (role === 'user') return { ...(usage.input !== undefined ? { input: usage.input } : {}) };
  return {
    ...(usage.output !== undefined ? { output: usage.output } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    ...(tool !== undefined ? { tool } : {})
  };
}

function toolTokensFromInputDelta(currentInput: number | undefined, previousModelInput: number | undefined, userInputSincePreviousModel: number): number | undefined {
  if (currentInput === undefined || previousModelInput === undefined) return undefined;
  return Math.max(0, currentInput - previousModelInput - userInputSincePreviousModel);
}

function nonInputFromTotal(usage: NormalizedTokenUsage): number | undefined {
  if (usage.total === undefined || usage.input === undefined) return undefined;
  return Math.max(0, usage.total - usage.input);
}

function buildSystemPromptEntry(
  firstModelUsage: { usage: NormalizedTokenUsage; floorNumber: number } | undefined,
  userInputBeforeFirstModel: number
): Omit<TokenUsageMessageEntry, 'ratio'> | undefined {
  if (!firstModelUsage?.usage.total) return undefined;
  const total = Math.max(0, firstModelUsage.usage.total - userInputBeforeFirstModel);
  if (total <= 0) return undefined;
  return {
    id: 'system-prompt-floor-0',
    kind: 'system',
    index: 0,
    total,
    input: total,
    totalEstimated: firstModelUsage.usage.totalEstimated === true,
    sourceEstimated: firstModelUsage.usage.sourceEstimated === true,
    fixedRatio: true
  };
}

function usageNumber(usage: LlmUsageMetadataRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    if (!hasOwn.call(usage, key)) continue;
    const numeric = normalizeTokenNumber(usage[key]);
    if (numeric !== undefined) return numeric;
  }
  return undefined;
}

function normalizeTokenNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  let hasValue = false;
  let total = 0;
  for (const value of values) {
    if (value === undefined) continue;
    hasValue = true;
    total += value;
  }
  return hasValue ? total : undefined;
}

function formatScaledNumber(value: number, scale: number): string {
  return (value / scale).toFixed(1).replace(/\.0$/, '');
}
