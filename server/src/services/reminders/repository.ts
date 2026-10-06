import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';

/**
 * Phase 10 — server-side repository for `public.assistant_reminders`.
 *
 * Phase 10 only *records* reminder rows (status `pending`); scheduling and
 * delivery are Phase 13. Design rules, matching the other repositories:
 *  - Every query is scoped with `.eq('user_id', userId)`; `userId` always comes
 *    from the authenticated request, never the client body.
 *  - When Supabase is unconfigured reads degrade to `[]`/`null` and writes
 *    return `null` (the orchestrator then continues without a reminder row).
 */

const TABLE = 'assistant_reminders';

export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

/** Row shape of `public.assistant_reminders`. */
export interface ReminderRecord {
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
}

/** Raised when a reminder database operation fails. */
export class ReminderRepositoryError extends Error {
  constructor(operation: string, message: string) {
    super(`[reminders] ${operation} failed: ${message}`);
    this.name = 'ReminderRepositoryError';
  }
}

/** Input for {@link createReminder}. */
export interface CreateReminderRecordInput {
  taskId: string;
  scheduledFor: string;
  timezone?: string | null;
  channel?: string;
  recurrence?: string | null;
}

function client(): SupabaseClient | null {
  return supabaseAdmin;
}

/** Inserts a `pending` reminder owned by `userId`. */
export async function createReminder(
  userId: string,
  input: CreateReminderRecordInput
): Promise<ReminderRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from(TABLE)
    .insert({
      user_id: userId,
      task_id: input.taskId,
      scheduled_for: input.scheduledFor,
      timezone: input.timezone ?? null,
      channel: input.channel ?? 'in_app',
      status: 'pending',
      recurrence: input.recurrence ?? null,
    })
    .select('*')
    .single();

  if (error) {
    throw new ReminderRepositoryError('createReminder', error.message);
  }

  return (data as ReminderRecord | null) ?? null;
}

/** Lists the caller's reminders for one task, soonest first. */
export async function listRemindersForTask(
  userId: string,
  taskId: string
): Promise<ReminderRecord[]> {
  const admin = client();
  if (!admin) return [];

  const { data, error } = await admin
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('task_id', taskId)
    .order('scheduled_for', { ascending: true });

  if (error) {
    throw new ReminderRepositoryError('listRemindersForTask', error.message);
  }

  return (data as ReminderRecord[] | null) ?? [];
}

/**
 * Cancels a reminder owned by `userId` (sets `status: 'cancelled'`). Returns the
 * updated row, or `null` when no owned row matched.
 */
export async function cancelReminder(
  userId: string,
  reminderId: string
): Promise<ReminderRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from(TABLE)
    .update({ status: 'cancelled' })
    .eq('user_id', userId)
    .eq('id', reminderId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new ReminderRepositoryError('cancelReminder', error.message);
  }

  return (data as ReminderRecord | null) ?? null;
}

/** Partial patch for {@link updateReminder}. Only provided keys are written. */
export interface UpdateReminderPatch {
  scheduledFor?: string;
  timezone?: string | null;
}

/**
 * Phase 11 — updates a pending reminder owned by `userId` (new schedule and/or
 * timezone). Full scheduling/delivery remains Phase 13; this only edits the row.
 *
 * Returns the updated row, or `null` when no owned row matched.
 */
export async function updateReminder(
  userId: string,
  reminderId: string,
  patch: UpdateReminderPatch
): Promise<ReminderRecord | null> {
  const admin = client();
  if (!admin) return null;

  const payload: Record<string, unknown> = {};
  if (patch.scheduledFor !== undefined) payload.scheduled_for = patch.scheduledFor;
  if (patch.timezone !== undefined) payload.timezone = patch.timezone;

  // An empty patch would make PostgREST reject the request; read the row instead.
  if (Object.keys(payload).length === 0) {
    const { data, error } = await admin
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('id', reminderId)
      .maybeSingle();
    if (error) {
      throw new ReminderRepositoryError('updateReminder', error.message);
    }
    return (data as ReminderRecord | null) ?? null;
  }

  const { data, error } = await admin
    .from(TABLE)
    .update(payload)
    .eq('user_id', userId)
    .eq('id', reminderId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new ReminderRepositoryError('updateReminder', error.message);
  }

  return (data as ReminderRecord | null) ?? null;
}

/** Fetches a single reminder owned by `userId`, or `null` when absent. */
export async function getReminderById(
  userId: string,
  reminderId: string
): Promise<ReminderRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('id', reminderId)
    .maybeSingle();

  if (error) {
    throw new ReminderRepositoryError('getReminderById', error.message);
  }

  return (data as ReminderRecord | null) ?? null;
}

// --- Phase 13 — worker + user-facing scheduling helpers ----------------------

/**
 * Columns the engine and the UI actually need. Selecting an explicit list (rather
 * than `*`) keeps future columns from leaking and documents the contract.
 */
const REMINDER_COLUMNS =
  'id, task_id, user_id, scheduled_for, timezone, channel, status, recurrence, sent_at, failure_reason, created_at, updated_at';

const DEFAULT_DUE_LIMIT = 50;
const MAX_DUE_LIMIT = 500;
const DEFAULT_USER_REMINDER_LIMIT = 50;
const MAX_USER_REMINDER_LIMIT = 200;

/**
 * Worker query: every **user's** pending reminder that is due
 * (`scheduled_for <= nowIso`), soonest first. Not user-scoped by design — this is
 * the cross-user scheduler tick. It only ever reads the columns above.
 */
export async function listDueReminders(
  nowIso: string,
  limit: number = DEFAULT_DUE_LIMIT
): Promise<ReminderRecord[]> {
  const admin = client();
  if (!admin) return [];

  const capped = Math.min(Math.max(limit, 1), MAX_DUE_LIMIT);

  const { data, error } = await admin
    .from(TABLE)
    .select(REMINDER_COLUMNS)
    .eq('status', 'pending')
    .lte('scheduled_for', nowIso)
    .order('scheduled_for', { ascending: true })
    .limit(capped);

  if (error) {
    throw new ReminderRepositoryError('listDueReminders', error.message);
  }

  return (data as ReminderRecord[] | null) ?? [];
}

/**
 * Atomically claims a reminder for delivery by transitioning `pending → sent`.
 *
 * The conditional update (`WHERE id = ? AND status = 'pending'`) is the
 * idempotency guard: only the first caller matches a row. A second concurrent
 * tick — or a replayed tick — matches nothing and receives `null`, so the
 * notification is never delivered twice. `sent_at` is filled in afterwards by
 * {@link markReminderSent}, or the claim is reversed by
 * {@link markReminderFailed} when dispatch fails.
 */
export async function claimReminder(reminderId: string): Promise<ReminderRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from(TABLE)
    .update({ status: 'sent' })
    .eq('id', reminderId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (error) {
    throw new ReminderRepositoryError('claimReminder', error.message);
  }

  return (data as ReminderRecord | null) ?? null;
}

/** Records a successful delivery (`sent_at`), clearing any prior failure. */
export async function markReminderSent(
  reminderId: string,
  sentAt: string
): Promise<ReminderRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from(TABLE)
    .update({ status: 'sent', sent_at: sentAt, failure_reason: null })
    .eq('id', reminderId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new ReminderRepositoryError('markReminderSent', error.message);
  }

  return (data as ReminderRecord | null) ?? null;
}

/** Records a delivery failure with a human-readable `failure_reason`. */
export async function markReminderFailed(
  reminderId: string,
  reason: string
): Promise<ReminderRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from(TABLE)
    .update({ status: 'failed', failure_reason: reason.slice(0, 500) })
    .eq('id', reminderId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new ReminderRepositoryError('markReminderFailed', error.message);
  }

  return (data as ReminderRecord | null) ?? null;
}

/**
 * Worker helper: resets a reminder to `pending` at a new `scheduled_for`. Used to
 * arm the next occurrence of a recurring reminder (a fresh row is created
 * instead; this helper exists for explicit re-arming).
 */
export async function rescheduleReminder(
  reminderId: string,
  scheduledFor: string,
  timezone?: string | null
): Promise<ReminderRecord | null> {
  const admin = client();
  if (!admin) return null;

  const payload: Record<string, unknown> = {
    scheduled_for: scheduledFor,
    status: 'pending',
    sent_at: null,
    failure_reason: null,
  };
  if (timezone !== undefined) payload.timezone = timezone;

  const { data, error } = await admin
    .from(TABLE)
    .update(payload)
    .eq('id', reminderId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new ReminderRepositoryError('rescheduleReminder', error.message);
  }

  return (data as ReminderRecord | null) ?? null;
}

/** Filters accepted by {@link listRemindersForUser}. */
export interface ListRemindersForUserFilters {
  status?: ReminderStatus;
  /** Inclusive lower bound on `scheduled_for` (ISO). */
  from?: string;
  /** Inclusive upper bound on `scheduled_for` (ISO). */
  to?: string;
  limit?: number;
}

/** Lists the caller's reminders, soonest first, within an optional window. */
export async function listRemindersForUser(
  userId: string,
  filters: ListRemindersForUserFilters = {}
): Promise<ReminderRecord[]> {
  const admin = client();
  if (!admin) return [];

  let query = admin.from(TABLE).select('*').eq('user_id', userId);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.from) query = query.gte('scheduled_for', filters.from);
  if (filters.to) query = query.lte('scheduled_for', filters.to);

  const capped = Math.min(
    Math.max(filters.limit ?? DEFAULT_USER_REMINDER_LIMIT, 1),
    MAX_USER_REMINDER_LIMIT
  );

  const { data, error } = await query
    .order('scheduled_for', { ascending: true })
    .limit(capped);

  if (error) {
    throw new ReminderRepositoryError('listRemindersForUser', error.message);
  }

  return (data as ReminderRecord[] | null) ?? [];
}
