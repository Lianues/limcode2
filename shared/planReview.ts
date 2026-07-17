import type {
  PlanProposalStatus,
  SubmitPlanDecisionStatus,
  SubmitPlanToolOutputRecord,
  SubmitPlanToolRequestRecord
} from './protocol';

export const SUBMIT_PLAN_MAX_TITLE_LENGTH = 200;
export const SUBMIT_PLAN_MAX_BODY_LENGTH = 40_000;
export const SUBMIT_PLAN_MAX_LIST_ITEMS = 40;
export const SUBMIT_PLAN_MAX_LIST_ITEM_LENGTH = 500;

export function normalizeSubmitPlanToolRequest(value: unknown): SubmitPlanToolRequestRecord {
  const record = asRecord(parseJsonValue(value));
  if (!record) throw new Error('submit_plan arguments must be an object');

  const plan = requiredText(record.plan, 'plan', SUBMIT_PLAN_MAX_BODY_LENGTH);
  const title = optionalLimitedText(record.title, 'title', SUBMIT_PLAN_MAX_TITLE_LENGTH);
  const risks = optionalStringList(record.risks, 'risks');
  const files = optionalStringList(record.files, 'files');

  return {
    ...(title ? { title } : {}),
    plan,
    ...(risks.length > 0 ? { risks } : {}),
    ...(files.length > 0 ? { files } : {})
  };
}

export function submitPlanRequestFromArgs(value: unknown): SubmitPlanToolRequestRecord | undefined {
  try {
    return normalizeSubmitPlanToolRequest(value);
  } catch {
    return undefined;
  }
}

export function createSubmitPlanToolOutput(input: {
  proposalId: string;
  status: SubmitPlanDecisionStatus;
  request: SubmitPlanToolRequestRecord;
  userMessage?: string;
}): SubmitPlanToolOutputRecord {
  const userMessage = input.userMessage?.trim();
  return {
    kind: 'submit_plan.result',
    proposalId: input.proposalId,
    status: input.status,
    ...(input.request.title ? { title: input.request.title } : {}),
    plan: input.request.plan,
    ...(input.request.risks && input.request.risks.length > 0 ? { risks: [...input.request.risks] } : {}),
    ...(input.request.files && input.request.files.length > 0 ? { files: [...input.request.files] } : {}),
    ...(userMessage ? { userMessage } : {})
  };
}

export function submitPlanOutputFromResult(value: unknown): SubmitPlanToolOutputRecord | undefined {
  const envelope = asRecord(value);
  const rawOutput = envelope && 'output' in envelope ? envelope.output : value;
  const output = asRecord(rawOutput);
  if (!output || output.kind !== 'submit_plan.result') return undefined;
  if (typeof output.proposalId !== 'string' || !output.proposalId.trim()) return undefined;
  if (!isSubmitPlanDecisionStatus(output.status)) return undefined;
  if (typeof output.plan !== 'string' || !output.plan.trim()) return undefined;

  const title = optionalText(output.title);
  const risks = outputStringList(output.risks);
  const files = outputStringList(output.files);
  const userMessage = optionalText(output.userMessage);
  return {
    kind: 'submit_plan.result',
    proposalId: output.proposalId.trim(),
    status: output.status,
    ...(title ? { title } : {}),
    plan: output.plan.trim(),
    ...(risks.length > 0 ? { risks } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(userMessage ? { userMessage } : {})
  };
}

export function planProposalStatusToDecision(status: PlanProposalStatus): SubmitPlanDecisionStatus | undefined {
  if (status === 'approved' || status === 'change_requested' || status === 'rejected') return status;
  return undefined;
}

function isSubmitPlanDecisionStatus(value: unknown): value is SubmitPlanDecisionStatus {
  return value === 'approved' || value === 'change_requested' || value === 'rejected';
}

function optionalStringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  if (value.length > SUBMIT_PLAN_MAX_LIST_ITEMS) throw new Error(`${label} must not exceed ${SUBMIT_PLAN_MAX_LIST_ITEMS} items`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const text = requiredText(item, `${label}[${index}]`, SUBMIT_PLAN_MAX_LIST_ITEM_LENGTH);
    if (seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function outputStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('submit_plan arguments must be valid JSON');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const text = value.trim();
  if (!text) throw new Error(`${label} must be a non-empty string`);
  if (text.length > maxLength) throw new Error(`${label} must not exceed ${maxLength} characters`);
  return text;
}

function optionalLimitedText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new Error(`${label} must not exceed ${maxLength} characters`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}
