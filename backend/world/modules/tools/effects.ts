import type { ToolConfigRecord, WorkEnvironmentRecord } from '../../../../shared/protocol';

export interface ToolRunEffect {
  kind: 'tool.run';
  toolCallId: string;
  name: string;
  argsJson: string;
  runId?: string;
  conversationId?: string;
  config?: ToolConfigRecord;
  workEnvironment?: WorkEnvironmentRecord;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'tool.run': ToolRunEffect;
  }
}
