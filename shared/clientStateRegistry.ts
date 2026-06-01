import type { ClientState, ClientStateTableKey } from './protocol';

export type ClientStatePatchOperation = 'upsert' | 'append' | 'remove';
export type ClientStatePatchMode = 'generic' | 'custom';
export type ClientStateDiffMode = 'generic' | 'custom';

export interface ClientStatePayloadPatchSpec {
  readonly kind: string;
  readonly payloadField: string;
}

export interface ClientStateRemovePatchSpec {
  readonly kind: string;
}

export interface ClientStateTablePatchSpec {
  readonly upsert?: ClientStatePayloadPatchSpec;
  readonly append?: ClientStatePayloadPatchSpec;
  readonly remove?: ClientStateRemovePatchSpec;
}

export interface ClientStateTableClientSyncSpec {
  /** 是否由 ClientSync 注册表自动生成 prev/next 的 upsert/remove diff。 */
  readonly diff: ClientStateDiffMode;
  /** 前端对应 patch 操作能否用通用 upsert/removeById 处理。 */
  readonly apply: Readonly<Partial<Record<ClientStatePatchOperation, ClientStatePatchMode>>>;
  /** global client state stream 的 snapshot 是否包含该表。 */
  readonly globalSnapshot: boolean;
}

export interface ClientStateTableSpec {
  readonly patch: ClientStateTablePatchSpec;
  readonly clientSync: ClientStateTableClientSyncSpec;
}

export type ClientStateTableRegistry = {
  readonly [TKey in ClientStateTableKey]: ClientStateTableSpec;
};

interface ClientSyncOverrides {
  readonly diff?: ClientStateDiffMode;
  readonly apply?: Readonly<Partial<Record<ClientStatePatchOperation, ClientStatePatchMode>>>;
  readonly globalSnapshot?: boolean;
}

type UpsertRemoveTableSpec<TPatchPrefix extends string, TPayloadField extends string> = {
  readonly patch: {
    readonly upsert: {
      readonly kind: `${TPatchPrefix}.upsert`;
      readonly payloadField: TPayloadField;
    };
    readonly remove: {
      readonly kind: `${TPatchPrefix}.remove`;
    };
  };
  readonly clientSync: ClientStateTableClientSyncSpec;
};

type AppendRemoveTableSpec<TPatchPrefix extends string, TPayloadField extends string> = {
  readonly patch: {
    readonly append: {
      readonly kind: `${TPatchPrefix}.append`;
      readonly payloadField: TPayloadField;
    };
    readonly remove: {
      readonly kind: `${TPatchPrefix}.remove`;
    };
  };
  readonly clientSync: ClientStateTableClientSyncSpec;
};

function clientSyncSpec(defaultApply: Readonly<Partial<Record<ClientStatePatchOperation, ClientStatePatchMode>>>, overrides: ClientSyncOverrides = {}): ClientStateTableClientSyncSpec {
  return {
    diff: overrides.diff ?? 'generic',
    apply: { ...defaultApply, ...overrides.apply },
    globalSnapshot: overrides.globalSnapshot ?? true
  };
}

function upsertRemoveTable<const TPatchPrefix extends string, const TPayloadField extends string>(
  patchPrefix: TPatchPrefix,
  payloadField: TPayloadField,
  clientSync: ClientSyncOverrides = {}
): UpsertRemoveTableSpec<TPatchPrefix, TPayloadField> {
  return {
    patch: {
      upsert: { kind: `${patchPrefix}.upsert`, payloadField },
      remove: { kind: `${patchPrefix}.remove` }
    },
    clientSync: clientSyncSpec({ upsert: 'generic', remove: 'generic' }, clientSync)
  };
}

function appendRemoveTable<const TPatchPrefix extends string, const TPayloadField extends string>(
  patchPrefix: TPatchPrefix,
  payloadField: TPayloadField,
  clientSync: ClientSyncOverrides = {}
): AppendRemoveTableSpec<TPatchPrefix, TPayloadField> {
  return {
    patch: {
      append: { kind: `${patchPrefix}.append`, payloadField },
      remove: { kind: `${patchPrefix}.remove` }
    },
    clientSync: clientSyncSpec({ append: 'generic', remove: 'generic' }, clientSync)
  };
}

const conversationScopedTable: ClientSyncOverrides = { globalSnapshot: false };
const messageTable: ClientSyncOverrides = {
  diff: 'custom',
  apply: { upsert: 'custom', remove: 'custom' },
  globalSnapshot: false
};
const toolCallEventsTable: ClientSyncOverrides = {
  diff: 'custom',
  apply: { append: 'custom' },
  globalSnapshot: false
};

export const CLIENT_STATE_TABLES = {
  agents: upsertRemoveTable('agent', 'agent'),
  agentModes: upsertRemoveTable('agentMode', 'agentMode'),
  toolPolicies: upsertRemoveTable('toolPolicy', 'toolPolicy'),
  approvalPolicies: upsertRemoveTable('approvalPolicy', 'approvalPolicy'),
  systemPrompts: upsertRemoveTable('systemPrompt', 'systemPrompt'),
  modelProfiles: upsertRemoveTable('modelProfile', 'modelProfile'),
  agentModeLinks: upsertRemoveTable('agentModeLink', 'link'),
  modeToolPolicyLinks: upsertRemoveTable('modeToolPolicyLink', 'link'),
  modeApprovalPolicyLinks: upsertRemoveTable('modeApprovalPolicyLink', 'link'),
  modeSystemPromptLinks: upsertRemoveTable('modeSystemPromptLink', 'link'),
  modeModelProfileLinks: upsertRemoveTable('modeModelProfileLink', 'link'),
  conversations: upsertRemoveTable('conversation', 'conversation', { apply: { remove: 'custom' } }),
  conversationReuseLinks: upsertRemoveTable('conversationReuseLink', 'link'),
  conversationBranchLinks: upsertRemoveTable('conversationBranchLink', 'link'),
  agentConversationLinks: upsertRemoveTable('agentConversationLink', 'link'),
  messages: upsertRemoveTable('message', 'message', messageTable),
  messageRevisions: upsertRemoveTable('messageRevision', 'revision', conversationScopedTable),
  messageCurrentRevisionLinks: upsertRemoveTable('messageCurrentRevisionLink', 'link', conversationScopedTable),
  toolCalls: upsertRemoveTable('toolcall', 'toolCall', { apply: { remove: 'custom' }, globalSnapshot: false }),
  toolCallEvents: appendRemoveTable('toolcallEvent', 'event', toolCallEventsTable),
  agentRuns: upsertRemoveTable('agentRun', 'run', { apply: { remove: 'custom' } }),
  agentRunSourceLinks: upsertRemoveTable('agentRunSourceLink', 'link'),
  agentRunTargetLinks: upsertRemoveTable('agentRunTargetLink', 'link'),
  messageRunLinks: upsertRemoveTable('messageRunLink', 'link'),
  toolCallRunLinks: upsertRemoveTable('toolCallRunLink', 'link'),
  runConversationPolicies: upsertRemoveTable('runConversationPolicy', 'policy'),
  runContextPolicies: upsertRemoveTable('runContextPolicy', 'policy'),
  runDeliveryPolicies: upsertRemoveTable('runDeliveryPolicy', 'policy'),
  runEditPolicies: upsertRemoveTable('runEditPolicy', 'policy'),
  runModeLinks: upsertRemoveTable('runModeLink', 'link'),
  runSystemPromptLinks: upsertRemoveTable('runSystemPromptLink', 'link'),
  runModelProfileLinks: upsertRemoveTable('runModelProfileLink', 'link'),
  runToolPolicyLinks: upsertRemoveTable('runToolPolicyLink', 'link'),
  runApprovalPolicyLinks: upsertRemoveTable('runApprovalPolicyLink', 'link'),
  runConversationPolicyLinks: upsertRemoveTable('runConversationPolicyLink', 'link'),
  runContextPolicyLinks: upsertRemoveTable('runContextPolicyLink', 'link'),
  runDeliveryPolicyLinks: upsertRemoveTable('runDeliveryPolicyLink', 'link'),
  runEditPolicyLinks: upsertRemoveTable('runEditPolicyLink', 'link'),
  agentRunInputRevisions: upsertRemoveTable('agentRunInputRevision', 'inputRevision')
} as const satisfies ClientStateTableRegistry;

export const CLIENT_STATE_TABLE_KEYS = Object.keys(CLIENT_STATE_TABLES) as ClientStateTableKey[];

export const GLOBAL_CLIENT_STATE_TABLE_KEYS = CLIENT_STATE_TABLE_KEYS.filter((key) => CLIENT_STATE_TABLES[key].clientSync.globalSnapshot);

export const GENERIC_CLIENT_STATE_DIFF_TABLE_KEYS = CLIENT_STATE_TABLE_KEYS.filter((key) => CLIENT_STATE_TABLES[key].clientSync.diff === 'generic');

export interface GenericClientPatchApplyOperation {
  readonly tableKey: ClientStateTableKey;
  readonly operation: ClientStatePatchOperation;
  readonly payloadField?: string;
}

export const GENERIC_CLIENT_PATCH_APPLY_BY_KIND: Readonly<Record<string, GenericClientPatchApplyOperation>> = createGenericClientPatchApplyByKind();

export function createEmptyClientState(): ClientState {
  const state: Partial<Record<ClientStateTableKey, unknown[]>> = {};
  for (const key of CLIENT_STATE_TABLE_KEYS) state[key] = [];
  return state as ClientState;
}

export function copyClientStateTables<TTarget extends ClientState>(
  target: TTarget,
  source: ClientState,
  keys: readonly ClientStateTableKey[]
): TTarget {
  const writableTarget = target as unknown as Record<ClientStateTableKey, unknown>;
  const readableSource = source as unknown as Record<ClientStateTableKey, unknown>;
  for (const key of keys) writableTarget[key] = readableSource[key];
  return target;
}

export function clientStateWithTables(source: ClientState, keys: readonly ClientStateTableKey[]): ClientState {
  return copyClientStateTables(createEmptyClientState(), source, keys);
}

function createGenericClientPatchApplyByKind(): Readonly<Record<string, GenericClientPatchApplyOperation>> {
  const operations: Record<string, GenericClientPatchApplyOperation> = {};
  for (const tableKey of CLIENT_STATE_TABLE_KEYS) {
    const spec = CLIENT_STATE_TABLES[tableKey];
    const patch = spec.patch as ClientStateTablePatchSpec;
    const apply = spec.clientSync.apply;
    if (patch.upsert && apply.upsert === 'generic') {
      operations[patch.upsert.kind] = { tableKey, operation: 'upsert', payloadField: patch.upsert.payloadField };
    }
    if (patch.append && apply.append === 'generic') {
      operations[patch.append.kind] = { tableKey, operation: 'append', payloadField: patch.append.payloadField };
    }
    if (patch.remove && apply.remove === 'generic') {
      operations[patch.remove.kind] = { tableKey, operation: 'remove' };
    }
  }
  return operations;
}
