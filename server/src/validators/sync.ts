import { z } from 'zod';

/**
 * Phase 16 — request validation for `/api/sync`.
 *
 * `direction` selects which half of the reconciliation runs; omitting it (or an
 * empty body) defaults to `both`.
 */
export const SYNC_DIRECTIONS = ['both', 'pull', 'push'] as const;

export type SyncDirectionInput = (typeof SYNC_DIRECTIONS)[number];

export const syncRequestSchema = z
  .object({
    direction: z.enum(SYNC_DIRECTIONS).optional(),
  })
  .strict();

export type SyncRequestInput = z.infer<typeof syncRequestSchema>;
