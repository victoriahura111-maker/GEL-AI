import { z } from 'zod';

/**
 * Phase 14 — request contracts for `/api/notifications`.
 *
 * `user_id` is deliberately absent everywhere: it always comes from the
 * authenticated request. Reads are always scoped to the caller.
 */

export const NOTIFICATION_STATUSES = ['unread', 'read'] as const;

/** `GET /api/notifications` query. Unknown keys are ignored (filtered by Zod). */
export const notificationListQuerySchema = z.object({
  status: z.enum(NOTIFICATION_STATUSES).optional(),
  type: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().trim().min(1).max(200).optional(),
});

/** Path id guard (opaque). */
export const notificationIdParamSchema = z.string().trim().min(1).max(200);

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
