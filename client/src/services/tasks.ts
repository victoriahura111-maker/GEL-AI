import { apiRequest } from './api';

/**
 * Phase 12 — typed wrappers around the task dashboard endpoints. Every call goes
 * through `apiRequest`, which attaches the Supabase Bearer token. The server
 * scopes all results to the authenticated user.
 */

export type TaskPriority = 'low' | 'medium' | 'high';

export type TaskStatus =
  | 'not_started'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'overdue';

export const TASK_STATUSES: TaskStatus[] = [
  'not_started',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
  'overdue',
];

export const TASK_PRIORITIES: TaskPriority[] = ['low', 'medium', 'high'];

/** A task mirror row returned by the API (snake_case, as stored). */
export interface Task {
  id: string;
  user_id: string;
  notion_page_id: string | null;
  notion_database_id: string | null;
  /** Resolved title of the task's mapped Notion database, when known. */
  notion_database_name: string | null;
  notion_url: string | null;
  title: string;
  description: string | null;
  category: string | null;
  priority: TaskPriority | null;
  status: TaskStatus;
  due_date: string | null;
  due_time: string | null;
  timezone: string | null;
  source_of_change: 'assistant' | 'notion' | 'system' | null;
  sync_status: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskSummaryCounts {
  today: number;
  upcoming: number;
  overdue: number;
  inProgress: number;
  awaitingUpdate: number;
  completed: number;
}

export interface TaskSummary {
  counts: TaskSummaryCounts;
  generatedAt: string;
  timezone: string;
}

export interface TaskBuckets {
  today: Task[];
  upcoming: Task[];
  overdue: Task[];
  inProgress: Task[];
  awaitingUpdate: Task[];
  completed: Task[];
}

export interface GroupedTasks {
  buckets: TaskBuckets;
  generatedAt: string;
  timezone: string;
}

/** Query filters accepted by `GET /api/tasks`. */
export interface TaskListFilters {
  status?: TaskStatus;
  dueBefore?: string;
  dueAfter?: string;
  category?: string;
  limit?: number;
}

/** Serialises defined filters into a query string (empty when none). */
export function buildTaskQuery(filters: TaskListFilters = {}): string {
  const params = new URLSearchParams();

  if (filters.status) params.set('status', filters.status);
  if (filters.dueBefore) params.set('dueBefore', filters.dueBefore);
  if (filters.dueAfter) params.set('dueAfter', filters.dueAfter);
  if (filters.category) params.set('category', filters.category);
  if (typeof filters.limit === 'number') params.set('limit', String(filters.limit));

  const query = params.toString();
  return query ? `?${query}` : '';
}

/** `GET /api/tasks` — the caller's tasks with optional filters. */
export function listTasks(filters: TaskListFilters = {}): Promise<Task[]> {
  return apiRequest<{ tasks: Task[] }>(`/api/tasks${buildTaskQuery(filters)}`).then(
    (response) => response.tasks
  );
}

/** `GET /api/tasks/summary` — the six dashboard bucket counts. */
export function getTaskSummary(): Promise<TaskSummary> {
  return apiRequest<TaskSummary>('/api/tasks/summary');
}

/** `GET /api/tasks/grouped` — the per-bucket task lists. */
export function getGroupedTasks(): Promise<GroupedTasks> {
  return apiRequest<GroupedTasks>('/api/tasks/grouped');
}

/** `GET /api/tasks/:id` — a single task (404 when missing or not owned). */
export function getTask(id: string): Promise<Task> {
  return apiRequest<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}`).then(
    (response) => response.task
  );
}
