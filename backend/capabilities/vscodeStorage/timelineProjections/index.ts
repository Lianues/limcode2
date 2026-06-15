import { taskListTimelineProjection } from './taskList';
import type { TimelineProjectionSpec } from './types';

export const BUILTIN_TIMELINE_PROJECTIONS: readonly TimelineProjectionSpec[] = [
  taskListTimelineProjection as TimelineProjectionSpec
];

export { TASK_LIST_TIMELINE_PROJECTION_KEY, taskListTimelineProjection } from './taskList';
export type { ConversationTimelineChunkData, TimelineProjectionSpec } from './types';
