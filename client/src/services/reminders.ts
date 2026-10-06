import { apiRequest } from './api';

/**
 * Phase 13 — typed wrappers around the `/api/reminders` endpoints. Every call
 * goes through `apiRequest`, which attaches the Supabase Bearer token; the server
 * scopes all results to the authenticated user.
 */

export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

/** Compact task reference attached to a reminder. */
export interface ReminderTask {
  id: string;
  title: string;
  due_date: string | null;
  due_time: string | null;
  status: string;
  notion_url: string | null;
}

/** A reminder row returned by the API. */
export interface Reminder {
  id: string;
  task_id: string;
  user_id: string;
  scheduled_for: string;
  timezone: string | null;
  channel: string;
  status: ReminderStatus;
  recurrence: string | null;
  sent_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  task: ReminderTask | null;
}

export interface ReminderListFilters {
  status?: ReminderStatus;
  from?: string;
  to?: string;
  limit?: number;
}

/** Scheduling inputs shared by create + reschedule. */
export interface ReminderSchedulePayload {
  scheduledFor?: string;
  datetime?: string;
  before?: string;
  timezone?: string | null;
}

export interface CreateReminderPayload extends ReminderSchedulePayload {
  taskId: string;
  recurrence?: 'daily' | 'weekly' | null;
}

/** Serialises defined filters into a query string (empty when none). */
export function buildReminderQuery(filters: ReminderListFilters = {}): string {
  const params = new URLSearchParams();

  if (filters.status) params.set('status', filters.status);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (typeof filters.limit === 'number') params.set('limit', String(filters.limit));

  const query = params.toString();
  return query ? `?${query}` : '';
}

/** `GET /api/reminders` — the caller's reminders (default: recent + upcoming). */
export function listReminders(filters: ReminderListFilters = {}): Promise<Reminder[]> {
  return apiRequest<{ reminders: Reminder[] }>(`/api/reminders${buildReminderQuery(filters)}`).then(
    (response) => response.reminders
  );
}

/** `POST /api/reminders/:id/cancel` — cancels an owned reminder. */
export function cancelReminder(id: string): Promise<Reminder> {
  return apiRequest<{ reminder: Reminder }>(
    `/api/reminders/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' }
  ).then((response) => response.reminder);
}

/** `POST /api/reminders/:id/reschedule` — re-arms an owned reminder. */
export function rescheduleReminder(
  id: string,
  payload: ReminderSchedulePayload
): Promise<Reminder> {
  return apiRequest<{ reminder: Reminder }>(
    `/api/reminders/${encodeURIComponent(id)}/reschedule`,
    { method: 'POST', body: JSON.stringify(payload) }
  ).then((response) => response.reminder);
}

/** `POST /api/reminders` — creates a reminder for one of the caller's tasks. */
export function createReminder(payload: CreateReminderPayload): Promise<Reminder> {
  return apiRequest<{ reminder: Reminder }>('/api/reminders', {
    method: 'POST',
    body: JSON.stringify(payload),
  }).then((response) => response.reminder);
}
