import {
  applyTaskListOperationToSnapshot,
  emptyTaskListSnapshot,
  sortedTaskListToolCalls,
  taskListOperationFromToolCall,
  type TaskListSnapshotView
} from '../../../../shared/taskListProjection';
import type { ToolCallRecord } from '../../../../shared/protocol';
import type { TimelineProjectionSpec } from './types';

export const TASK_LIST_TIMELINE_PROJECTION_KEY = 'task-list';

export const taskListTimelineProjection: TimelineProjectionSpec<TaskListSnapshotView> = {
  key: TASK_LIST_TIMELINE_PROJECTION_KEY,
  emptySnapshot: emptyTaskListSnapshot,
  reduceChunk(input) {
    let snapshot = input.previousSnapshot;
    let operationIndex = input.operationStartIndex;
    let operationCount = 0;

    const taskListCalls = sortedTaskListToolCalls(input.chunk.messages, input.chunk.toolCalls, input.conversationId)
      .filter(isAppliedTaskListToolCall);
    for (const call of taskListCalls) {
      const operation = taskListOperationFromToolCall(call, { allowArgsFallback: true });
      if (!operation) continue;
      snapshot = applyTaskListOperationToSnapshot(snapshot, operation, { operationIndex, toolCallId: call.id });
      operationIndex += 1;
      operationCount += 1;
    }

    return {
      snapshotAfterChunk: snapshot,
      operationCount,
      operationEndIndex: operationIndex
    };
  }
};

function isAppliedTaskListToolCall(toolCall: ToolCallRecord): boolean {
  if (toolCall.status !== 'success' && toolCall.status !== 'warning') return false;
  const result = asRecord(toolCall.result);
  return result?.ok !== false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
