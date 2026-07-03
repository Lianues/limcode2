import type { LlmInvocationSettingsSnapshotRecord, ToolConfigRecord, WorkEnvironmentRecord } from '../../../../shared/protocol';
import type { FsPendingFileChangeProposal } from '../../../capabilities/types';

export interface ToolRunEffect {
  kind: 'tool.run';
  toolCallId: string;
  name: string;
  argsJson: string;
  runId?: string;
  conversationId?: string;
  config?: ToolConfigRecord;
  settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
  workEnvironment?: WorkEnvironmentRecord;
  workEnvironments?: WorkEnvironmentRecord[];
  accessibleWorkEnvironments?: WorkEnvironmentRecord[];
}

export interface ToolChangeApplyEffect {
  kind: 'tool.change.apply';
  toolCallId: string;
  name: string;
  proposal: FsPendingFileChangeProposal;
  workEnvironment?: WorkEnvironmentRecord;
  accessibleWorkEnvironments?: WorkEnvironmentRecord[];
  allowOutsideProjectPaths?: boolean;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'tool.run': ToolRunEffect;
    'tool.change.apply': ToolChangeApplyEffect;
  }
}
