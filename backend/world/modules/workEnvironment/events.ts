import type {
  WorkEnvironmentPolicyScopeClearPayload,
  WorkEnvironmentPolicyScopeSetPayload,
  WorkEnvironmentRecord,
  WorkEnvironmentRemovePayload,
  WorkEnvironmentUpsertPayload
} from '../../../../shared/protocol';

export interface LocalWorkEnvironmentCandidate {
  id: string;
  name: string;
  uri: string;
  rootPath: string;
  displayPath?: string;
  index: number;
}

export interface WorkEnvironmentWorkspaceFoldersSyncedPayload {
  folders: LocalWorkEnvironmentCandidate[];
}

export interface WorkEnvironmentSelectPayload {
  conversationId: string;
  workEnvironmentId: string;
}

export interface WorkEnvironmentImportFromVscodePayload {
  records: WorkEnvironmentRecord[];
}

export const WorkEnvironmentEventType = {
  WorkspaceFoldersSynced: 'workEnvironment:workspaceFoldersSynced',
  ConversationSelectRequested: 'workEnvironment:conversationSelectRequested',
  UpsertRequested: 'workEnvironment:upsertRequested',
  RemoveRequested: 'workEnvironment:removeRequested',
  ImportFromVscodeRequested: 'workEnvironment:importFromVscodeRequested',
  PolicyScopeSetRequested: 'workEnvironmentPolicy:scopeSetRequested',
  PolicyScopeClearRequested: 'workEnvironmentPolicy:scopeClearRequested'
} as const;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'workEnvironment:workspaceFoldersSynced': WorkEnvironmentWorkspaceFoldersSyncedPayload;
    'workEnvironment:conversationSelectRequested': WorkEnvironmentSelectPayload;
    'workEnvironment:upsertRequested': WorkEnvironmentUpsertPayload;
    'workEnvironment:removeRequested': WorkEnvironmentRemovePayload;
    'workEnvironment:importFromVscodeRequested': WorkEnvironmentImportFromVscodePayload;
    'workEnvironmentPolicy:scopeSetRequested': WorkEnvironmentPolicyScopeSetPayload;
    'workEnvironmentPolicy:scopeClearRequested': WorkEnvironmentPolicyScopeClearPayload;
  }
}
