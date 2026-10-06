import { notionRequest, requireAccessToken } from './client';
import { normalizeNotionDatabaseId } from '../../validators/notionDatabase';

/**
 * Phase 10 — Notion page writes (`POST /pages`, `GET /pages/:id`,
 * `PATCH /pages/:id`).
 *
 * Built on the shared authenticated request helper from
 * {@link ./client.notionRequest}: the caller's decrypted token is read from the
 * connection repository and sent as `Authorization: Bearer`, with the pinned
 * `Notion-Version` header and the client's typed error mapping
 * ({@link NotionApiError}; `401`/`403` map to a "reconnect" signal).
 *
 * Security invariants (inherited from the client):
 *  - The access token is never logged, returned, or embedded in an error.
 *  - Raw Notion payloads never leave the server; only `{ id, url }` is returned.
 *  - Every call is scoped to a single authenticated `userId`.
 */

/** Normalised page reference returned to callers. */
export interface NotionPageSummary {
  id: string;
  url: string | null;
}

/** Reads the caller's decrypted token; throws `not_connected` when absent. */
function requireToken(userId: string): Promise<string> {
  return requireAccessToken(userId);
}

/** Converts a raw Notion page object into the normalised `{ id, url }` shape. */
function toPageSummary(raw: Record<string, unknown>): NotionPageSummary | null {
  const rawId = raw.id;
  if (typeof rawId !== 'string' || rawId.length === 0) return null;

  return {
    id: normalizeNotionDatabaseId(rawId),
    url: typeof raw.url === 'string' && raw.url.length > 0 ? raw.url : null,
  };
}

/**
 * Creates a page in the given Notion database with the supplied `properties`
 * payload (built by {@link ../propertyMapping.buildNotionProperties}).
 *
 * @throws {NotionApiError} `not_connected` | `unauthorized` | `forbidden` |
 * `not_found` | `rate_limited` | `invalid_response` | `network_error` |
 * `api_error`. `401`/`403` mean the user must reconnect Notion.
 */
export async function createNotionPage(
  userId: string,
  databaseId: string,
  properties: Record<string, unknown>
): Promise<NotionPageSummary> {
  const accessToken = await requireToken(userId);
  const payload = await notionRequest(accessToken, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: normalizeNotionDatabaseId(databaseId) },
      properties,
    }),
  });

  const summary = toPageSummary(payload);
  if (!summary) {
    throw new Error('Notion did not return a usable page id.');
  }
  return summary;
}

/**
 * Retrieves a page's `{ id, url }`. Minimal for Phase 10; Phase 11 may widen it
 * with properties. Kept user-scoped via the shared token resolution.
 *
 * @throws {NotionApiError} same set as {@link createNotionPage}.
 */
export async function retrievePage(userId: string, pageId: string): Promise<NotionPageSummary> {
  const accessToken = await requireToken(userId);
  const payload = await notionRequest(
    accessToken,
    `/pages/${encodeURIComponent(normalizeNotionDatabaseId(pageId))}`,
    { method: 'GET' }
  );

  const summary = toPageSummary(payload);
  if (!summary) {
    throw new Error('Notion did not return a usable page id.');
  }
  return summary;
}

/**
 * Updates a page's `properties` (`PATCH /pages/:id`). Not used in Phase 10; it
 * exists so Phase 11 task updates reuse one typed, user-scoped write path.
 *
 * @throws {NotionApiError} same set as {@link createNotionPage}.
 */
export async function updatePage(
  userId: string,
  pageId: string,
  properties: Record<string, unknown>
): Promise<NotionPageSummary> {
  const accessToken = await requireToken(userId);
  const payload = await notionRequest(
    accessToken,
    `/pages/${encodeURIComponent(normalizeNotionDatabaseId(pageId))}`,
    { method: 'PATCH', body: JSON.stringify({ properties }) }
  );

  const summary = toPageSummary(payload);
  if (!summary) {
    throw new Error('Notion did not return a usable page id.');
  }
  return summary;
}

/**
 * Archives a page (`PATCH /pages/:id { archived: true }`). Introduced in Phase 11
 * for the "move between databases" flow (a page cannot change its parent, so the
 * original must be archived after the replacement is created) and for
 * `delete_task` (archive instead of hard-deleting so the user can recover the
 * page from Notion trash).
 *
 * @throws {NotionApiError} same set as {@link createNotionPage}.
 */
export async function archivePage(userId: string, pageId: string): Promise<NotionPageSummary> {
  const accessToken = await requireToken(userId);
  const payload = await notionRequest(
    accessToken,
    `/pages/${encodeURIComponent(normalizeNotionDatabaseId(pageId))}`,
    { method: 'PATCH', body: JSON.stringify({ archived: true }) }
  );

  const summary = toPageSummary(payload);
  if (!summary) {
    throw new Error('Notion did not return a usable page id.');
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* Phase 16 — database page query (pull)                               */
/* ------------------------------------------------------------------ */

/**
 * A normalised Notion page for the sync engine. `properties` is the raw
 * properties map, kept **server-internal** — it is never returned to a browser.
 * The sync engine reverse-maps it into internal task fields.
 */
export interface NotionPageRecord {
  id: string;
  url: string | null;
  archived: boolean;
  inTrash: boolean;
  createdTime: string | null;
  lastEditedTime: string | null;
  parentDatabaseId: string | null;
  properties: Record<string, unknown>;
}

export interface NotionPageQueryResult {
  pages: NotionPageRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Notion's maximum page size for `/databases/:id/query`. */
const QUERY_PAGE_SIZE = 100;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Normalises a raw Notion page object into {@link NotionPageRecord}. */
function toPageRecord(raw: Record<string, unknown>): NotionPageRecord | null {
  const rawId = raw.id;
  if (typeof rawId !== 'string' || rawId.length === 0) return null;

  const properties =
    raw.properties && typeof raw.properties === 'object'
      ? (raw.properties as Record<string, unknown>)
      : {};

  let parentDatabaseId: string | null = null;
  const parent = raw.parent;
  if (parent && typeof parent === 'object') {
    const databaseId = (parent as { database_id?: unknown }).database_id;
    if (typeof databaseId === 'string' && databaseId.length > 0) {
      parentDatabaseId = normalizeNotionDatabaseId(databaseId);
    }
  }

  return {
    id: normalizeNotionDatabaseId(rawId),
    url: asString(raw.url),
    archived: raw.archived === true,
    inTrash: raw.in_trash === true,
    createdTime: asString(raw.created_time),
    lastEditedTime: asString(raw.last_edited_time),
    parentDatabaseId,
    properties,
  };
}

/**
 * Queries a Notion database's pages (`POST /databases/:id/query`), sorted by
 * `last_edited_time` ascending and optionally filtered to pages edited strictly
 * *after* a watermark (the user's last successful sync; the epoch on a first run).
 *
 * One page of results is fetched per call; the caller follows `nextCursor`. The
 * raw provider payload never leaves the server — only the normalised
 * {@link NotionPageRecord} shape (whose `properties` stays server-side) is returned.
 *
 * @throws {NotionApiError} same typed set as the other page functions.
 */
export async function queryDatabasePages(
  userId: string,
  databaseId: string,
  options: { lastEditedAfter?: string; startCursor?: string | null; pageSize?: number } = {}
): Promise<NotionPageQueryResult> {
  const accessToken = await requireToken(userId);
  const id = normalizeNotionDatabaseId(databaseId);

  const body: Record<string, unknown> = {
    page_size: options.pageSize ?? QUERY_PAGE_SIZE,
    sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
  };
  if (options.lastEditedAfter) {
    body.filter = {
      timestamp: 'last_edited_time',
      last_edited_time: { after: options.lastEditedAfter },
    };
  }
  if (options.startCursor) body.start_cursor = options.startCursor;

  const payload = await notionRequest(
    accessToken,
    `/databases/${encodeURIComponent(id)}/query`,
    { method: 'POST', body: JSON.stringify(body) }
  );

  const results = Array.isArray(payload.results) ? payload.results : [];
  const pages = results
    .map((item) => (item && typeof item === 'object' ? toPageRecord(item as Record<string, unknown>) : null))
    .filter((page): page is NotionPageRecord => page !== null);

  const nextCursor = typeof payload.next_cursor === 'string' ? payload.next_cursor : null;
  const hasMore = payload.has_more === true && Boolean(nextCursor);

  return { pages, nextCursor: hasMore ? nextCursor : null, hasMore };
}
