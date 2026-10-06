import { z } from 'zod';

export const updateProfileSchema = z
  .object({
    full_name: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((value) => value.full_name !== undefined || value.timezone !== undefined, {
    message: 'Provide at least one field to update (full_name or timezone).',
  });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
