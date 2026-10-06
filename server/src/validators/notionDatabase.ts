import { z } from 'zod';

/**
 * Phase 8 — Notion database discovery + purpose configuration.
 *
 * The single source of truth for the purposes a Notion database can be mapped
 * to. The values mirror the CHECK constraint in
 * `database/migrations/0007_notion_database_mappings.sql`.
 *
 * Later phases (database selection, task creation) consume these purposes to
 * decide which Notion database a task belongs in.
 */
export const NOTION_DATABASE_PURPOSES = [
  'work',
  'personal',
  'school',
  'projects',
  'other',
] as const;

export type NotionDatabasePurpose = (typeof NOTION_DATABASE_PURPOSES)[number];

/**
 * Notion database ids are UUID-like: 32 hex characters, optionally separated by
 * dashes. Notion may return either the dashed or the compact form, so both are
 * accepted and normalised to the dashed lowercase form for storage/comparison.
 */
const NOTION_DATABASE_ID_PATTERN =
  /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

/** Normalises a 32-character hex Notion id to dashed lowercase form. */
export function normalizeNotionDatabaseId(value: string): string {
  const compact = value.replace(/-/g, '').toLowerCase();
  if (compact.length !== 32) return value;
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}

/** Validates and normalises the `:databaseId` path parameter. */
export const notionDatabaseIdSchema = z
  .string()
  .trim()
  .regex(NOTION_DATABASE_ID_PATTERN, 'Invalid Notion database id')
  .transform(normalizeNotionDatabaseId);

/** An allowed mapping purpose. */
export const notionPurposeSchema = z.enum(NOTION_DATABASE_PURPOSES);

/**
 * Body accepted by `PUT /api/notion/databases/:databaseId/mapping`.
 * `isDefault` is optional; omitting it preserves the existing default flag.
 */
export const upsertDatabaseMappingSchema = z
  .object({
    purpose: notionPurposeSchema,
    isDefault: z.boolean().optional(),
  })
  .strict();

export type UpsertDatabaseMappingInput = z.infer<typeof upsertDatabaseMappingSchema>;
