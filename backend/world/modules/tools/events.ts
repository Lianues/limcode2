import type { ToolCallEventKind, ToolCallStatus, ToolDecisionPayload, ToolPolicyScopeClearPayload, ToolPolicyScopeSetPayload } from '../../../../shared/protocol';

export const ToolEventType = {
  State: 'tool:state',
  PolicyScopeSetRequested: 'tool:policyScopeSetRequested',
  PolicyScopeClearRequested: 'tool:policyScopeClearRequested',
  ExecutionApproveRequested: 'tool:executionApproveRequested',
  ExecutionRejectRequested: 'tool:executionRejectRequested',
  ChangeApplyRequested: 'tool:changeApplyRequested',
  ChangeRejectRequested: 'tool:changeRejectRequested',
  ResultSubmitRequested: 'tool:resultSubmitRequested',
  ResultRejectRequested: 'tool:resultRejectRequested'
} as const;

export interface ToolStatePayload {
  toolCallId: string;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
  progress?: unknown;
  eventKind?: ToolCallEventKind;
  delta?: string;
  durationMs?: number;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'tool:state': ToolStatePayload;
    'tool:policyScopeSetRequested': ToolPolicyScopeSetPayload;
    'tool:policyScopeClearRequested': ToolPolicyScopeClearPayload;
    'tool:executionApproveRequested': ToolDecisionPayload;
    'tool:executionRejectRequested': ToolDecisionPayload;
    'tool:changeApplyRequested': ToolDecisionPayload;
    'tool:changeRejectRequested': ToolDecisionPayload;
    'tool:resultSubmitRequested': ToolDecisionPayload;
    'tool:resultRejectRequested': ToolDecisionPayload;
  }
}
