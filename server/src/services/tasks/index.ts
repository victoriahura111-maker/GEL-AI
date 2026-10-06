export {
  createTaskRecord,
  getTaskById,
  updateTaskRecord,
  listTasks,
  deleteTaskRecord,
  findTasksByTitleFragment,
  findTaskByNotionPageId,
  listTasksForSync,
  TaskRepositoryError,
} from './repository';
export type { TaskPriority, TaskStatus, TaskSource, TaskRecord } from './repository';

export { createTask, CreateTaskError, createTaskServiceInputSchema } from './createTask';
export type {
  CreateTaskOptions,
  CreateTaskReminderInput,
  CreateTaskResult,
  CreateTaskServiceInput,
} from './createTask';

// Phase 11 — resolution + update/move/delete.
export { resolveTask } from './resolveTask';
export type { TaskResolution } from './resolveTask';

export { applyTaskUpdate, deleteTask, UpdateTaskError } from './updateTask';
export type { ApplyTaskUpdateResult, DeleteTaskResult } from './updateTask';
export type { TaskUpdateChanges } from '../../validators/assistantAction';

// Phase 12 — dashboard read models (timezone-aware buckets + validated list).
export {
  getTaskSummary,
  getTasksGrouped,
  listTasksForUser,
  summarizeTasks,
  groupTasks,
  classifyTask,
  buildLocalClock,
  resolveTimeZone,
  TaskQueryError,
  TASK_BUCKET_ORDER,
  GROUPED_BUCKET_LIMIT,
  AWAITING_WINDOW_HOURS,
} from './query';
export type {
  TaskBucketName,
  TaskBucketFlags,
  TaskSummary,
  TaskSummaryCounts,
  TaskBuckets,
  GroupedTasks,
  LocalClock,
} from './query';
