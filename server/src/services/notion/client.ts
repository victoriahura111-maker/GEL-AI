import { getConnection } from './connectionRepository';
import { NOTION_VERSION } from './oauth';
import { normalizeNotionDatabaseId } from '../../validators/notionDatabase';

/**
 * Phase 8 — authenticated Notion API client (database discovery).
 *
 * Security invariants:
 * - The access token is read from the encrypted connection repository (decrypted
 *   in-process only) and sent as `Authorization: Bearer`. It is never logged,
 *   never returned, and never included in a thrown error message.
 * - Errors are typed and user-safe: clients receive a short message plus a stable
 *   `code`, never the raw Notion payload or HTTP body.
 * - All calls are scoped to a single authenticated `userId`; there is no way to
 *   read another user's Notion data.
 *
 * Built on the native `fetch` (Node 18+). No retries are performed — a single
 * attempt is made and failures are mapped cleanly (kept intentionally simple for
 * this phase).
 */

const NOTION_API_BASE = 'https://api.notion.com/v1';

/** Safe cap on how many `/search` pages we follow in one call. */
export const MAX_SEARCH_PAGES = 5;

/** Notion's maximum page size for `/search`. */
const SEARCH_PAGE_SIZE = 100;

export type NotionApiErrorCode =
  | 'not_connected'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'invalid_response'
  | 'network_error'
  | 'api_error';

/**
 * Typed, user-safe Notion API error.
 * `status` is the upstream HTTP status when one was received, else `null`.
 * The message never contains the access token or a raw provider payload.
 */
export class NotionApiError extends Error {
  readonly code: NotionApiErrorCode;
  readonly status: number | null;

  constructor(message: string, code: NotionApiErrorCode, status: number | null = null) {
    super(message);
    this.name = 'NotionApiError';
    this.code = code;
    this.status = status;
  }
}

/** Normalised database shape exposed to the app (never a raw Notion payload). */
export interface NotionDatabaseSummary {
  id: string;
  title: string;
  url: string | null;
  /** Emoji or image URL, normalised to a string, or `null`. */
  icon: string | null;
}

/**
 * Returns the caller's decrypted access token, or throws `not_connected`.
 * Exported so sibling Notion services (`schema`, `pages`) share the same
 * user-scoped token resolution instead of duplicating it. The token is never
 * logged or returned to a client.
 */
export async function requireAccessToken(userId: string): Promise<string> {
  const connection = await getConnection(userId);
  if (!connection) {
    throw new NotionApiError('Connect Notion first.', 'not_connected', null);
  }
  return connection.accessToken;
}

/** Maps an upstream non-OK status to a typed, user-safe error. */
function mapErrorStatus(status: number): NotionApiError {
  if (status === 401) {
    return new NotionApiError('Reconnect Notion to continue.', 'unauthorized', status);
  }
  if (status === 403) {
    return new NotionApiError('Reconnect Notion to continue.', 'forbidden', status);
  }
  if (status === 404) {
    return new NotionApiError('That Notion resource could not be found.', 'not_found', status);
  }
  if (status === 429) {
    return new NotionApiError(
      'Notion is rate limiting requests. Please try again shortly.',
      'rate_limited',
      status
    );
  }
  return new NotionApiError('Notion could not complete the request.', 'api_error', status);
}

/**
 * Performs an authenticated JSON request against the Notion API and returns the
 * parsed object. Throws a {@link NotionApiError} on any failure.
 */
export async function notionRequest(
  accessToken: string,
  path: string,
  init: RequestInit
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${NOTION_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
    });
  } catch {
    // Never surface the underlying error or the request headers.
    throw new NotionApiError('Could not reach Notion. Please try again.', 'network_error', null);
  }

  if (!response.ok) {
    throw mapErrorStatus(response.status);
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new NotionApiError(
      'Notion returned an unreadable response.',
      'invalid_response',
      response.status
    );
  }
}

/** Extracts the plain-text title from Notion's `title[]` rich-text array. */
function extractTitle(database: Record<string, unknown>): string {
  const title = database.title;
  if (!Array.isArray(title)) return 'Untitled';

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

  return text.length > 0 ? text : 'Untitled';
}

/** Normalises a Notion `icon` (emoji or external file) to a string, or `null`. */
function extractIcon(database: Record<string, unknown>): string | null {
  const icon = database.icon;
  if (!icon || typeof icon !== 'object') return null;

  const record = icon as Record<string, unknown>;
  if (typeof record.emoji === 'string' && record.emoji.length > 0) return record.emoji;

  const external = record.external;
  if (external && typeof external === 'object') {
    const url = (external as { url?: unknown }).url;
    if (typeof url === 'string' && url.length > 0) return url;
  }

  if (typeof record.url === 'string' && record.url.length > 0) return record.url;
  return null;
}

/** Converts a raw Notion database object into the normalised summary shape. */
function toDatabaseSummary(raw: Record<string, unknown>): NotionDatabaseSummary | null {
  const rawId = raw.id;
  if (typeof rawId !== 'string' || rawId.length === 0) return null;

  return {
    id: normalizeNotionDatabaseId(rawId),
    title: extractTitle(raw),
    url: typeof raw.url === 'string' && raw.url.length > 0 ? raw.url : null,
    icon: extractIcon(raw),
  };
}

/**
 * Lists the Notion databases the connected integration has access to.
 *
 * Uses `POST /search` filtered to `object: database`, sorted by most recently
 * edited, following `next_cursor` up to {@link MAX_SEARCH_PAGES} pages. Only
 * databases explicitly shared with the integration are returned by Notion.
 *
 * @throws {NotionApiError} `not_connected` | `unauthorized` | `forbidden` |
 * `rate_limited` | `invalid_response` | `network_error` | `api_error`.
 */
export async function listDatabases(userId: string): Promise<NotionDatabaseSummary[]> {
  const accessToken = await requireAccessToken(userId);

  const databases: NotionDatabaseSummary[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const body: Record<string, unknown> = {
      filter: { property: 'object', value: 'database' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: SEARCH_PAGE_SIZE,
    };
    if (cursor) body.start_cursor = cursor;

    const payload = await notionRequest(accessToken, '/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const results = Array.isArray(payload.results) ? payload.results : [];
    for (const item of results) {
      if (item && typeof item === 'object') {
        const summary = toDatabaseSummary(item as Record<string, unknown>);
        if (summary) databases.push(summary);
      }
    }

    const nextCursor = typeof payload.next_cursor === 'string' ? payload.next_cursor : null;
    const hasMore = payload.has_more === true && Boolean(nextCursor);
    cursor = hasMore ? nextCursor : null;
    pages += 1;
  } while (cursor && pages < MAX_SEARCH_PAGES);

  return databases;
}

/**
 * Fetches the RAW Notion database object (`GET /databases/:id`), including its
 * `properties` map. This is the building block for schema inspection
 * ({@link ./schema.getDatabaseSchema}); the raw payload never leaves the server.
 *
 * The caller's decrypted token is read from the connection repository, exactly
 * like {@link listDatabases}, so all access remains user-scoped.
 *
 * @throws {NotionApiError} same set as {@link listDatabases} (`not_connected`,
 * `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `invalid_response`,
 * `network_error`, `api_error`).
 */
export async function getDatabaseRaw(
  userId: string,
  databaseId: string
): Promise<Record<string, unknown> | null> {
  const accessToken = await requireAccessToken(userId);
  const id = normalizeNotionDatabaseId(databaseId);

  return notionRequest(accessToken, `/databases/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
}

/**
 * Fetches a single Notion database's normalised summary (`GET /databases/:id`).
 *
 * Kept from Phase 8 for backwards compatibility (the discovery UI/tests rely on
 * the reduced `{ id, title, url, icon }` shape). Phase 9 schema inspection uses
 * {@link getDatabaseRaw} instead. Returns `null` when Notion returns no usable id.
 *
 * @throws {NotionApiError} same set as {@link listDatabases}.
 */
export async function getDatabase(
  userId: string,
  databaseId: string
): Promise<NotionDatabaseSummary | null> {
  const payload = await getDatabaseRaw(userId, databaseId);
  if (!payload) return null;
  return toDatabaseSummary(payload);
}
