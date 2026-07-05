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

/** 请求中断某个在途的运行时工具调用（尽力而为：触发 AbortController，MCP 侧传 signal）。 */
export interface ToolAbortEffect {
  kind: 'tool.abort';
  toolCallId: string;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'tool.run': ToolRunEffect;
    'tool.change.apply': ToolChangeApplyEffect;
    'tool.abort': ToolAbortEffect;
  }
}
