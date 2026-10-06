import { z } from 'zod';

/**
 * Phase 13 — request contracts for `/api/reminders`.
 *
 * `user_id` is deliberately absent everywhere: it always comes from the
 * authenticated request. Every reminder write is ownership-checked before it runs.
 */

export const REMINDER_STATUSES = ['pending', 'sent', 'failed', 'cancelled'] as const;

/** `GET /api/reminders` query. Unknown keys are ignored (filtered by Zod). */
export const reminderListQuerySchema = z.object({
  status: z.enum(REMINDER_STATUSES).optional(),
  from: z.string().trim().min(1).max(64).optional(),
  to: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const datetimeString = z.string().trim().min(1).max(64);
const timezone = z.string().trim().max(64);
const before = z.string().trim().min(1).max(64);
const recurrence = z.enum(['daily', 'weekly']);

/**
 * `POST /api/reminders` — create a reminder for one of the caller's tasks.
 * Accepts an absolute `scheduledFor`, a naive/absolute `datetime`, or a relative
 * `before` offset resolved against the task deadline.
 */
export const createReminderBodySchema = z
  .object({
    taskId: z.string().trim().min(1).max(64),
    scheduledFor: datetimeString.optional(),
    datetime: datetimeString.optional(),
    before: before.optional(),
    timezone: timezone.nullable().optional(),
    recurrence: recurrence.nullable().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.scheduledFor || value.datetime || value.before), {
    message: 'Provide one of scheduledFor, datetime, or before.',
    path: ['scheduledFor'],
  });

/** `POST /api/reminders/:id/reschedule` body. */
export const rescheduleReminderBodySchema = z
  .object({
    scheduledFor: datetimeString.optional(),
    datetime: datetimeString.optional(),
    before: before.optional(),
    timezone: timezone.nullable().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.scheduledFor || value.datetime || value.before), {
    message: 'Provide one of scheduledFor, datetime, or before.',
    path: ['scheduledFor'],
  });

/** Path id guard (opaque). */
export const reminderIdParamSchema = z.string().trim().min(1).max(200);

export type ReminderListQuery = z.infer<typeof reminderListQuerySchema>;
export type CreateReminderBody = z.infer<typeof createReminderBodySchema>;
export type RescheduleReminderBody = z.infer<typeof rescheduleReminderBodySchema>;
