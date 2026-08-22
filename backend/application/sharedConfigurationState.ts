import type { AgentRecord, ClientState, ClientStateTableKey } from '../../shared/protocol';
import { createEmptyClientState } from '../../shared/clientStateSchema';

/**
 * 跨工作区共享的低频配置图。
 *
 * scopeKind 只表达配置覆盖层级，不表达 workspace 所有权。因此所有配置 Link（包括
 * conversation/run scope）都与其配置 record 一起共享；Conversation、Run 主体仍由
 * workspace runtime skeleton 保存。
 */
export const SHARED_CONFIGURATION_TABLE_KEYS = [
  'agents',
  'workflows',
  'planReviewPolicies',
  'planReviewPolicyScopeLinks',
  'toolPolicies',
  'toolPolicyScopeLinks',
  'skillPolicies',
  'skillPolicyScopeLinks',
  'systemPrompts',
  'systemPromptScopeLinks',
  'runtimeContexts',
  'runtimeContextScopeLinks',
  'modelProfiles',
  'modelProfileScopeLinks',
  'workEnvironments',
  'workEnvironmentPolicies',
  'workEnvironmentPolicyScopeLinks',
  'checkpointPolicies',
  'checkpointPolicyScopeLinks'
] as const satisfies readonly ClientStateTableKey[];

const FULLY_SHARED_CONFIGURATION_TABLE_KEYS = SHARED_CONFIGURATION_TABLE_KEYS.filter(
  (key): key is Exclude<SharedConfigurationTableKey, 'agents'> => key !== 'agents'
);

type SharedConfigurationTableKey = typeof SHARED_CONFIGURATION_TABLE_KEYS[number];

export function sharedConfigurationState(state: ClientState): ClientState {
  const result = createEmptyClientState();
  result.agents = state.agents
    .filter((agent) => !isRuntimeMirrorAgent(agent))
    .map(normalizeSharedAgentRecord);
  for (const key of FULLY_SHARED_CONFIGURATION_TABLE_KEYS) {
    assignTable(result, key, recordsForTable(state, key));
  }
  return result;
}

export function workspaceRuntimeState(state: ClientState): ClientState {
  const result = cloneSerializable(state);
  result.agents = state.agents
    .filter(isRuntimeMirrorAgent)
    .map((agent) => cloneSerializable(agent));
  for (const key of FULLY_SHARED_CONFIGURATION_TABLE_KEYS) assignTable(result, key, []);
  return result;
}

/**
 * 共享 skeleton 为 canonical；workspace 中仍存在的共享表只作为首次规范化来源。
 * 不同 id 做 union，同 id 由共享 skeleton 覆盖。
 */
export function mergeSharedConfigurationAndWorkspaceRuntime(
  sharedState: ClientState | undefined,
  workspaceState: ClientState | undefined
): ClientState {
  const workspace = workspaceState ?? createEmptyClientState();
  const shared = sharedState ?? createEmptyClientState();
  const legacyShared = sharedConfigurationState(workspace);
  const canonicalShared = mergeSharedConfigurationStates(legacyShared, sharedConfigurationState(shared));
  const result = workspaceRuntimeState(workspace);

  result.agents = [
    ...canonicalShared.agents.map((agent) => cloneSerializable(agent)),
    ...result.agents.map((agent) => cloneSerializable(agent))
  ];
  for (const key of FULLY_SHARED_CONFIGURATION_TABLE_KEYS) {
    assignTable(result, key, recordsForTable(canonicalShared, key));
  }
  return result;
}

export function mergeSharedConfigurationStates(base: ClientState, incoming: ClientState): ClientState {
  const result = sharedConfigurationState(base);
  result.agents = mergeRecords(result.agents, incoming.agents.map(normalizeSharedAgentRecord));
  for (const key of FULLY_SHARED_CONFIGURATION_TABLE_KEYS) {
    assignTable(result, key, mergeRecords(recordsForTable(result, key), recordsForTable(incoming, key)));
  }
  return result;
}

function normalizeSharedAgentRecord(agent: AgentRecord): AgentRecord {
  const clone = cloneSerializable(agent);
  delete clone.runtimeRole;
  delete clone.typeAgentId;
  clone.status = 'idle';
  return clone;
}

function isRuntimeMirrorAgent(agent: AgentRecord): boolean {
  return agent.runtimeRole === 'mirror';
}

function recordsForTable(state: ClientState, key: SharedConfigurationTableKey): Array<{ id: string }> {
  return cloneSerializable(state[key] as Array<{ id: string }>);
}

function assignTable(state: ClientState, key: SharedConfigurationTableKey, records: Array<{ id: string }>): void {
  (state as unknown as Record<SharedConfigurationTableKey, Array<{ id: string }>>)[key] = cloneSerializable(records);
}

function mergeRecords<TRecord extends { id: string }>(base: readonly TRecord[], incoming: readonly TRecord[]): TRecord[] {
  const records = base.map((record) => cloneSerializable(record));
  const indexById = new Map(records.map((record, index) => [record.id, index]));
  for (const record of incoming) {
    const clone = cloneSerializable(record);
    const index = indexById.get(record.id);
    if (index === undefined) {
      indexById.set(record.id, records.length);
      records.push(clone);
    } else {
      records[index] = clone;
    }
  }
  return records;
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
