import type { CheckpointRecord, CheckpointTimelineAnchorRecord } from '@shared/protocol';

export interface CheckpointTimelineActionContext {
  checkpoint: CheckpointRecord;
  anchor: CheckpointTimelineAnchorRecord;
}

export interface CheckpointTimelineAction {
  id: string;
  label: string;
  description?: string;
  enabled(context: CheckpointTimelineActionContext): boolean;
  run(context: CheckpointTimelineActionContext): void;
}

const actions: CheckpointTimelineAction[] = [];

export function registerCheckpointTimelineAction(action: CheckpointTimelineAction): void {
  const index = actions.findIndex((candidate) => candidate.id === action.id);
  if (index >= 0) actions[index] = action;
  else actions.push(action);
}

export function checkpointTimelineActions(): readonly CheckpointTimelineAction[] {
  return actions;
}

registerCheckpointTimelineAction({
  id: 'rollback',
  label: '回档',
  description: '恢复工作区到此存档点',
  enabled: () => false,
  run: () => undefined
});

registerCheckpointTimelineAction({
  id: 'diff-from-previous',
  label: '查看变更',
  description: '查看此存档点与相邻存档点之间的变更',
  enabled: () => false,
  run: () => undefined
});
