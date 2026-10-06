import { getDatabaseRaw, NotionApiError } from './client';
import { normalizeNotionDatabaseId } from '../../validators/notionDatabase';

/**
 * Phase 9 — Notion database schema inspection.
 *
 * Reads the raw `GET /databases/:id` payload (via the user-scoped client) and
 * normalises Notion's `properties` OBJECT (keyed by property name) into a
 * stable, ordered ARRAY. Only the shape needed by the property-mapping service
 * is kept; the raw provider payload never leaves the server and is never
 * returned to clients.
 *
 * The normalised schema is intentionally a plain data structure (no Notion
 * types) so {@link ../propertyMapping.resolvePropertyMapping} can stay pure,
 * deterministic and trivially unit-testable.
 */

/**
 * The property types Phase 9 recognises and can map/build values for. Any other
 * Notion property type is still emitted (so callers can see it) but is reported
 * as `unsupported` by the mapping service rather than causing a failure.
 */
export const SUPPORTED_PROPERTY_TYPES = [
  'title',
  'rich_text',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'number',
  'url',
  'people',
] as const;

export type NotionPropertyType = (typeof SUPPORTED_PROPERTY_TYPES)[number];

/** A selectable option for `select` / `multi_select` / `status` properties. */
export interface NotionPropertyOption {
  id?: string;
  name: string;
  color?: string;
}

/** One normalised Notion property. */
export interface NotionPropertySchema {
  id: string;
  name: string;
  /** Notion's property type, or any unsupported type string as-is. */
  type: string;
  /** Present for `select`, `multi_select` and `status` properties. */
  options?: NotionPropertyOption[];
}

/** The normalised schema exposed to the rest of the app. */
export interface NotionDatabaseSchema {
  id: string;
  title: string;
  properties: NotionPropertySchema[];
}

/** Titles longer than Notion's own limit are clamped defensively. */
const FALLBACK_TITLE = 'Untitled';

/** Default TTL for the in-memory schema cache (milliseconds). */
export const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  schema: NotionDatabaseSchema;
}

/**
 * Tiny in-process TTL cache keyed by `(userId, databaseId)`. Best-effort only:
 * it exists to avoid re-fetching an unchanged schema within a short window and
 * is deliberately not shared across instances. Keyed by user id so one user can
 * never observe another user's schema.
 */
const schemaCache = new Map<string, CacheEntry>();

/** Clears the schema cache. Exposed for tests and for future invalidation. */
export function clearSchemaCache(): void {
  schemaCache.clear();
}

function cacheKey(userId: string, databaseId: string): string {
  return `${userId}::${databaseId}`;
}

/** Reads the plain-text title from Notion's top-level `title[]` rich-text array. */
function extractDatabaseTitle(raw: Record<string, unknown>): string {
  const title = raw.title;
  if (!Array.isArray(title)) return FALLBACK_TITLE;

  const text = title
    .map((item) => {
      if (item && typeof item === 'object' && 'plain_text' in item) {
        const plain = (item as { plain_text?: unknown }).plain_text;
        return typeof plain === 'string' ? plain : '';
      }
      return '';
    })
    .join('')
    .trim();

  return text.length > 0 ? text : FALLBACK_TITLE;
}

/** Normalises a single option object, dropping anything malformed. */
function toOption(value: unknown): NotionPropertyOption | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : null;
  if (!name) return null;

  const option: NotionPropertyOption = { name };
  if (typeof record.id === 'string' && record.id.length > 0) option.id = record.id;
  if (typeof record.color === 'string' && record.color.length > 0) option.color = record.color;
  return option;
}

/**
 * Extracts `options` for select-like properties. Notion nests them under a key
 * matching the property type (`select.options`, `multi_select.options`) except
 * for `status`, where they live under `status.options`.
 */
function extractOptions(
  property: Record<string, unknown>,
  type: string
): NotionPropertyOption[] | undefined {
  if (type !== 'select' && type !== 'multi_select' && type !== 'status') return undefined;

  const container = property[type];
  if (!container || typeof container !== 'object') return undefined;

  const rawOptions = (container as { options?: unknown }).options;
  if (!Array.isArray(rawOptions)) return undefined;

  const options = rawOptions
    .map(toOption)
    .filter((option): option is NotionPropertyOption => option !== null);

  return options.length > 0 ? options : undefined;
}

/** Flattens Notion's `properties` object into an ordered array. */
function flattenProperties(raw: Record<string, unknown>): NotionPropertySchema[] {
  const properties = raw.properties;
  if (!properties || typeof properties !== 'object') return [];

  const result: NotionPropertySchema[] = [];
  for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;

    const type = typeof record.type === 'string' ? record.type : 'unknown';
    const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : name;

    const property: NotionPropertySchema = { id, name, type };
    const options = extractOptions(record, type);
    if (options) property.options = options;
    result.push(property);
  }

  return result;
}

/** Converts a raw Notion database object into the normalised schema. */
export function toDatabaseSchema(raw: Record<string, unknown>): NotionDatabaseSchema | null {
  const rawId = raw.id;
  if (typeof rawId !== 'string' || rawId.length === 0) return null;

  return {
    id: normalizeNotionDatabaseId(rawId),
    title: extractDatabaseTitle(raw),
    properties: flattenProperties(raw),
  };
}

/**
 * Fetches and normalises a Notion database's schema for one user.
 *
 * @param userId   The authenticated caller (token is read from their connection).
 * @param databaseId A dashed or compact Notion database id.
 * @param options  `fresh: true` bypasses the TTL cache.
 *
 * @throws {NotionApiError} `not_connected` | `unauthorized` | `forbidden` |
 * `not_found` | `rate_limited` | `invalid_response` | `network_error` |
 * `api_error`. Also `not_found` when Notion returns no usable id.
 */
export async function getDatabaseSchema(
  userId: string,
  databaseId: string,
  options: { fresh?: boolean } = {}
): Promise<NotionDatabaseSchema> {
  const id = normalizeNotionDatabaseId(databaseId);
  const key = cacheKey(userId, id);

  if (!options.fresh) {
    const cached = schemaCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.schema;
    if (cached) schemaCache.delete(key);
  }

  const raw = await getDatabaseRaw(userId, id);
  const schema = raw ? toDatabaseSchema(raw) : null;
  if (!schema) {
    throw new NotionApiError('That Notion resource could not be found.', 'not_found', 404);
  }

  schemaCache.set(key, { expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS, schema });
  return schema;
}

/** Narrows a property to a known selectable type, for equality helpers. */
export function isSelectLikeType(type: string): boolean {
  return type === 'select' || type === 'multi_select' || type === 'status';
}
