import type { Request, Response } from 'express';
import { listDatabases, NotionApiError } from '../services/notion/client';
import { getDatabaseSchema } from '../services/notion/schema';
import { PropertyMappingError, resolvePropertyMapping } from '../services/notion/propertyMapping';
import {
  DatabaseMappingRepositoryError,
  deleteMapping,
  listMappings,
  upsertMapping,
} from '../services/notion/databaseMappingRepository';
import { notionDatabaseIdSchema, upsertDatabaseMappingSchema } from '../validators/notionDatabase';
import { writeAuditLog } from '../services/audit';

/**
 * Phase 8 — Notion database discovery + purpose configuration controllers.
 *
 * These handlers:
 *  - read the caller's Notion databases using the stored (decrypted) token,
 *  - merge them with the caller's saved purpose/default mappings,
 *  - and persist purpose/default changes.
 *
 * Only user-safe messages are returned: never the access token, raw Notion
 * payloads, or internal error text.
 */

interface PublicError {
  status: number;
  message: string;
}

/** Maps a typed Notion client error to a public status + message. */
function mapNotionError(error: unknown): PublicError | null {
  if (!(error instanceof NotionApiError)) return null;

  switch (error.code) {
    case 'not_connected':
      return { status: 409, message: 'Connect Notion first' };
    case 'unauthorized':
    case 'forbidden':
      return { status: 409, message: 'Reconnect Notion to continue' };
    case 'not_found':
      return { status: 404, message: error.message };
    case 'rate_limited':
      return { status: 429, message: error.message };
    case 'network_error':
    case 'invalid_response':
    case 'api_error':
    default:
      return { status: 502, message: error.message };
  }
}

/** Sends the mapped error, or `null` when the error was not a Notion API error. */
function respondNotionError(res: Response, error: unknown): boolean {
  const mapped = mapNotionError(error);
  if (!mapped) return false;
  res.status(mapped.status).json({ error: mapped.message });
  return true;
}

/** Maps a mapping-repository error to a public response. */
function respondRepositoryError(res: Response, error: unknown): boolean {
  if (!(error instanceof DatabaseMappingRepositoryError)) return false;
  const status = error.code === 'not_configured' ? 503 : 500;
  res.status(status).json({ error: 'Could not save your Notion database settings' });
  return true;
}

/**
 * `GET /api/notion/databases`
 *
 * Lists the databases shared with the integration, each annotated with the
 * caller's saved `purpose`/`isDefault`. `409` when Notion is not connected or
 * the connection must be re-established.
 */
export async function getNotionDatabases(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // Sequential so a missing connection surfaces deterministically as 409
    // (a repository "not configured" error must not win the race).
    const databases = await listDatabases(userId);
    const mappings = await listMappings(userId);

    const byId = new Map(mappings.map((mapping) => [mapping.notionDatabaseId, mapping]));

    res.json({
      databases: databases.map((database) => {
        const mapping = byId.get(database.id);
        return {
          id: database.id,
          title: database.title,
          url: database.url,
          icon: database.icon,
          purpose: mapping?.purpose ?? null,
          isDefault: mapping?.isDefault ?? false,
        };
      }),
    });
  } catch (error) {
    if (respondNotionError(res, error)) return;
    if (respondRepositoryError(res, error)) return;
    console.error('[notion] Could not list the available databases.');
    res.status(500).json({ error: 'Could not load your Notion databases' });
  }
}

/**
 * `PUT /api/notion/databases/:databaseId/mapping`
 *
 * Validates the purpose enum and the Notion database id, then upserts the
 * caller's mapping. When `isDefault` is true at most one default is kept.
 */
export async function putNotionDatabaseMapping(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const idResult = notionDatabaseIdSchema.safeParse(req.params.databaseId);
  if (!idResult.success) {
    res.status(400).json({ error: 'Invalid Notion database id' });
    return;
  }

  const bodyResult = upsertDatabaseMappingSchema.safeParse(req.body);
  if (!bodyResult.success) {
    res.status(400).json({
      error: 'Invalid mapping',
      details: bodyResult.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const mapping = await upsertMapping(userId, {
      notionDatabaseId: idResult.data,
      purpose: bodyResult.data.purpose,
      isDefault: bodyResult.data.isDefault,
    });

    // Best-effort audit of the database selection/purpose change. No secrets are
    // recorded — only the ids and the chosen purpose.
    await writeAuditLog(userId, {
      action: 'notion_database_selected',
      metadata: {
        notionDatabaseId: mapping.notionDatabaseId,
        purpose: mapping.purpose,
        isDefault: mapping.isDefault,
      },
    });

    res.json({ mapping });
  } catch (error) {
    if (respondNotionError(res, error)) return;
    if (respondRepositoryError(res, error)) return;
    console.error('[notion] Could not save the database mapping.');
    res.status(500).json({ error: 'Could not save the database mapping' });
  }
}

/**
 * `DELETE /api/notion/databases/:databaseId/mapping`
 *
 * Removes the caller's mapping for a Notion database.
 */
export async function deleteNotionDatabaseMapping(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const idResult = notionDatabaseIdSchema.safeParse(req.params.databaseId);
  if (!idResult.success) {
    res.status(400).json({ error: 'Invalid Notion database id' });
    return;
  }

  try {
    const removed = await deleteMapping(userId, idResult.data);
    res.json({ removed });
  } catch (error) {
    if (respondRepositoryError(res, error)) return;
    console.error('[notion] Could not remove the database mapping.');
    res.status(500).json({ error: 'Could not remove the database mapping' });
  }
}

/**
 * `GET /api/notion/databases/:databaseId/schema`
 *
 * Phase 9 — inspects one Notion database's properties and returns:
 *  - `database`: the normalised `{ id, title }`,
 *  - `properties`: the flattened property list (with `options` for select-like
 *    properties),
 *  - `mapping`: the internal-field → Notion-property-name mapping,
 *  - `unsupported`: properties of a type Phase 9 cannot map.
 *
 * The raw provider payload never leaves the server. Errors mirror the discovery
 * endpoint: `409` no connection / reconnect required, `404` not found, `400`
 * invalid id, `502` provider failure.
 */
export async function getNotionDatabaseSchema(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const idResult = notionDatabaseIdSchema.safeParse(req.params.databaseId);
  if (!idResult.success) {
    res.status(400).json({ error: 'Invalid Notion database id' });
    return;
  }

  try {
    const schema = await getDatabaseSchema(userId, idResult.data);
    const mapping = resolvePropertyMapping(schema);

    res.json({
      database: { id: schema.id, title: schema.title },
      properties: schema.properties,
      mapping,
      unsupported: mapping.unsupported,
    });
  } catch (error) {
    if (respondNotionError(res, error)) return;
    if (error instanceof PropertyMappingError) {
      // A database without a title property cannot be mapped for task sync.
      res.status(422).json({ error: error.message });
      return;
    }
    console.error('[notion] Could not inspect the database schema.');
    res.status(500).json({ error: 'Could not load the Notion database schema' });
  }
}
