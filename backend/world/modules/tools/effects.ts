import type { ToolConfigRecord, WorkEnvironmentRecord } from '../../../../shared/protocol';
import type { FsPendingFileChangeProposal } from '../../../capabilities/types';

export interface ToolRunEffect {
  kind: 'tool.run';
  toolCallId: string;
  name: string;
  argsJson: string;
  runId?: string;
  conversationId?: string;
  config?: ToolConfigRecord;
  workEnvironment?: WorkEnvironmentRecord;
  workEnvironments?: WorkEnvironmentRecord[];
}

export interface ToolChangeApplyEffect {
  kind: 'tool.change.apply';
  toolCallId: string;
  name: string;
  proposal: FsPendingFileChangeProposal;
  workEnvironment?: WorkEnvironmentRecord;
  allowOutsideProjectPaths?: boolean;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'tool.run': ToolRunEffect;
    'tool.change.apply': ToolChangeApplyEffect;
  }
}
