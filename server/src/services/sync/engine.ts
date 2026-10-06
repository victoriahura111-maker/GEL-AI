import { listMappings } from '../notion/databaseMappingRepository';
import { getDatabaseSchema } from '../notion/schema';
import type { NotionDatabaseSchema } from '../notion/schema';
import { buildNotionProperties, resolvePropertyMapping } from '../notion/propertyMapping';
import type { PropertyMapping } from '../notion/propertyMapping';
import { queryDatabasePages, updatePage } from '../notion/pages';
import type { NotionPageRecord } from '../notion/pages';
import { mapNotionPageToTask } from '../notion/notionToTask';
import type { NotionTaskFields } from '../notion/notionToTask';
import {
  createTaskRecord,
  findTaskByNotionPageId,
  listTasksForSync,
  updateTaskRecord,
} from '../tasks/repository';
import type { TaskRecord } from '../tasks/repository';
import type { CreateTaskInput, UpdateTaskPatch } from '../../validators/task';
import { writeAuditLog } from '../audit/auditLog';
import { getSyncState, setSyncState } from './syncStateRepository';
import type { SyncDirection } from './syncStateRepository';

/**
 * Phase 16 — Notion ⇄ local synchronization engine.
 *
 * `syncUser(userId, { direction, now })` is the **testable core**: a single,
 * throw-free reconciliation pass with a stable, typed summary. The periodic
 * scheduler and the `POST /api/sync` route both call it.
 *
 * ## Pull (Notion → local)
 *
 * For every database the user has mapped:
 *  1. fetch the normalised schema and resolve the field → property mapping;
 *  2. query the database's pages (`POST /databases/:id/query`), filtered by
 *     `last_edited_time after` the **watermark** (the user's last successful
 *     sync, else the epoch) and sorted ascending, following `next_cursor`;
 *  3. for each page, reverse-map it and then:
 *     - **no local task** → create a mirror row (`source_of_change:'notion'`,
 *       `sync_status:'synced'`, `last_synced_at:now`);
 *     - **local task exists** → **last-write-wins** (see below);
 *     - **archived / in trash** → mark the local task `status:'cancelled'` and
 *       `sync_status:'error'` (the documented rule) so the user sees that the
 *       Notion page is gone rather than silently keeping a live mirror.
 *
 * ## Last-write-wins (conflict policy)
 *
 * A conflict is resolved by comparing the Notion `last_edited_time` against the
 * local row's `updated_at`:
 *  - Notion **newer** → apply the Notion values locally (`source_of_change:'notion'`).
 *  - Local **newer or equal** → leave the row untouched; the push phase (if any)
 *    will send it to Notion. **A newer local change is never overwritten by a
 *    stale Notion value, and vice versa.**
 *
 * ## Push (local → Notion)
 *
 * Local tasks changed since their last sync that originated locally
 * (`source_of_change != 'notion'` **and** `updated_at > last_synced_at`, with a
 * null `last_synced_at` meaning "never synced") are rebuilt via the schema +
 * mapping and written with `updatePage`. On success the row becomes
 * `sync_status:'synced'` with `last_synced_at:now` (the local
 * `source_of_change` is retained); on failure it becomes `sync_status:'error'`
 * and the pass continues.
 *
 * ## Loop prevention (guarantees)
 *
 *  - After a **pull** write the row is stamped `source_of_change:'notion'`, so
 *    the push phase's candidate filter (`source_of_change != 'notion'`) skips
 *    it — a pulled row is never immediately pushed back.
 *  - After a **push**, `last_synced_at` is set to the sync instant; the next
 *    pull's per-row guard ignores any page whose `last_edited_time` is **≤**
 *    that row's `last_synced_at`, and the query watermark (`after now`) excludes
 *    it at the source — a pushed row is not re-pulled.
 *  - The user-level watermark (stored in `user_sync_state.last_synced_at`)
 *    advances to the run instant **only when the pull pass completed without
 *    errors**, so a failed item is retried on the next run instead of being
 *    silently skipped.
 *
 * ## Failure isolation
 *
 * Every database and every page/task is wrapped individually; a failure records
 * a safe message in `errors` and is otherwise skipped. `syncUser` **never throws**.
 */

export type { SyncDirection };

export interface SyncPullCounts {
  created: number;
  updated: number;
  skipped: number;
}

export interface SyncPushCounts {
  updated: number;
  failed: number;
}

export interface SyncError {
  /** e.g. `database:<id>` / `page:<id>` / `task:<id>` / `databases` / `state`. */
  scope: string;
  message: string;
}

export interface SyncSummary {
  direction: SyncDirection;
  pulled: SyncPullCounts;
  pushed: SyncPushCounts;
  errors: SyncError[];
  startedAt: string;
  finishedAt: string;
}

/** Default watermark for a user who has never completed a pull. */
export const SYNC_EPOCH = '1970-01-01T00:00:00.000Z';

/** Upper bound on `/query` pages followed per database in one pass. */
export const MAX_QUERY_PAGES = 10;

export interface SyncUserOptions {
  direction?: SyncDirection;
  now?: Date;
}

interface SyncContext {
  userId: string;
  watermark: string;
  nowIso: string;
  summary: SyncSummary;
}

/** Parses a timestamp to epoch milliseconds, or `null` when unusable. */
function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** True when `candidate` is a usable timestamp strictly after `reference`. */
function isAfter(candidate: string | null | undefined, reference: string | null | undefined): boolean {
  const candidateMs = timestampMs(candidate);
  if (candidateMs === null) return false;
  const referenceMs = timestampMs(reference);
  return referenceMs === null || candidateMs > referenceMs;
}

/** True when `candidate` is at or before `reference` (used by the loop guard). */
function isAtOrBefore(
  candidate: string | null | undefined,
  reference: string | null | undefined
): boolean {
  const candidateMs = timestampMs(candidate);
  const referenceMs = timestampMs(reference);
  if (candidateMs === null || referenceMs === null) return false;
  return candidateMs <= referenceMs;
}

/** A user-safe message: Notion errors are already safe; otherwise use `fallback`. */
function safeMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const name = (error as { name?: unknown }).name;
    const message = (error as { message?: unknown }).message;
    if (name === 'NotionApiError' && typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return fallback;
}

/** Best-effort audit write; never throws. */
function audit(userId: string, action: string, metadata: Record<string, unknown>): void {
  void writeAuditLog(userId, {
    action,
    taskId: (metadata.taskId as string | undefined) ?? null,
    notionPageId: (metadata.notionPageId as string | undefined) ?? null,
    toolName: 'sync_engine',
    metadata,
  }).catch(() => {
    console.error('[sync] Could not write a sync audit row.');
  });
}

/** Converts reverse-mapped fields into an update patch (skips undefined). */
function fieldsToPatch(fields: NotionTaskFields): UpdateTaskPatch {
  const patch: UpdateTaskPatch = {};
  if (fields.title !== undefined && fields.title !== null) patch.title = fields.title;
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.category !== undefined) patch.category = fields.category;
  if (fields.priority !== undefined) patch.priority = fields.priority;
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.due_date !== undefined) patch.due_date = fields.due_date;
  if (fields.due_time !== undefined) patch.due_time = fields.due_time;
  if (fields.timezone !== undefined) patch.timezone = fields.timezone;
  if (fields.notion_url !== undefined) patch.notion_url = fields.notion_url;
  return patch;
}

/** Builds the create input for a new mirror row from reverse-mapped fields. */
function toCreateInput(
  databaseId: string,
  page: NotionPageRecord,
  fields: NotionTaskFields,
  nowIso: string
): CreateTaskInput {
  return {
    title: fields.title ?? 'Untitled',
    description: fields.description ?? null,
    category: fields.category ?? null,
    priority: fields.priority ?? null,
    status: fields.status ?? 'not_started',
    due_date: fields.due_date ?? null,
    due_time: fields.due_time ?? null,
    timezone: fields.timezone ?? null,
    notion_page_id: page.id,
    notion_database_id: databaseId,
    notion_url: fields.notion_url ?? page.url ?? null,
    source_of_change: 'notion',
    sync_status: 'synced',
    last_synced_at: nowIso,
  };
}

/* ------------------------------------------------------------------ */
/* Pull                                                                */
/* ------------------------------------------------------------------ */

/** Pulls one database. Returns `true` when any page failed (blocks the watermark). */
async function pullDatabase(
  databaseId: string,
  ctx: SyncContext
): Promise<boolean> {
  let schema: NotionDatabaseSchema;
  try {
    schema = await getDatabaseSchema(ctx.userId, databaseId);
  } catch (error) {
    ctx.summary.errors.push({
      scope: `database:${databaseId}`,
      message: safeMessage(error, 'Could not load a Notion database.'),
    });
    return true;
  }

  let mapping: PropertyMapping;
  try {
    mapping = resolvePropertyMapping(schema);
  } catch {
    ctx.summary.errors.push({
      scope: `database:${databaseId}`,
      message: 'A Notion database has no mappable title property.',
    });
    return true;
  }

  let cursor: string | null = null;
  let pageCount = 0;
  let anyFailed = false;

  do {
    let result;
    try {
      result = await queryDatabasePages(ctx.userId, databaseId, {
        lastEditedAfter: ctx.watermark,
        startCursor: cursor,
      });
    } catch (error) {
      ctx.summary.errors.push({
        scope: `database:${databaseId}`,
        message: safeMessage(error, 'Could not read pages from a Notion database.'),
      });
      return true;
    }

    for (const page of result.pages) {
      const ok = await pullPage(databaseId, schema, mapping, page, ctx);
      if (!ok) anyFailed = true;
    }

    cursor = result.hasMore ? result.nextCursor : null;
    pageCount += 1;
  } while (cursor && pageCount < MAX_QUERY_PAGES);

  return anyFailed;
}

/** Applies one pulled page. Returns `false` when the page could not be applied. */
async function pullPage(
  databaseId: string,
  schema: NotionDatabaseSchema,
  mapping: PropertyMapping,
  page: NotionPageRecord,
  ctx: SyncContext
): Promise<boolean> {
  try {
    const existing = await findTaskByNotionPageId(ctx.userId, page.id);

    // Archived / trashed page: cancel the local mirror, flag it as an error.
    if (page.archived || page.inTrash) {
      if (!existing) {
        ctx.summary.pulled.skipped += 1;
        return true;
      }
      await updateTaskRecord(ctx.userId, existing.id, {
        status: 'cancelled',
        sync_status: 'error',
        source_of_change: 'notion',
        last_synced_at: ctx.nowIso,
      });
      ctx.summary.pulled.updated += 1;
      audit(ctx.userId, 'sync_page_archived', {
        taskId: existing.id,
        notionPageId: page.id,
      });
      return true;
    }

    const { fields, warnings } = mapNotionPageToTask(schema, mapping, page);
    if (warnings.length > 0) {
      console.warn(`[sync] Reverse-mapping warnings for page ${page.id}: ${warnings.join(' ')}`);
    }

    if (!existing) {
      await createTaskRecord(ctx.userId, toCreateInput(databaseId, page, fields, ctx.nowIso));
      ctx.summary.pulled.created += 1;
      return true;
    }

    // Loop prevention: a page not newer than the row's last sync is ignored.
    if (existing.last_synced_at && isAtOrBefore(page.lastEditedTime, existing.last_synced_at)) {
      ctx.summary.pulled.skipped += 1;
      return true;
    }

    // Last-write-wins: only apply when Notion is strictly newer than the mirror.
    if (!isAfter(page.lastEditedTime, existing.updated_at)) {
      ctx.summary.pulled.skipped += 1;
      return true;
    }

    await updateTaskRecord(ctx.userId, existing.id, {
      ...fieldsToPatch(fields),
      sync_status: 'synced',
      source_of_change: 'notion',
      last_synced_at: ctx.nowIso,
    });
    ctx.summary.pulled.updated += 1;
    return true;
  } catch (error) {
    ctx.summary.errors.push({
      scope: `page:${page.id}`,
      message: safeMessage(error, 'Could not sync a Notion page.'),
    });
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Push                                                                */
/* ------------------------------------------------------------------ */

/** True when a local row should be pushed to Notion. */
function isPushCandidate(task: TaskRecord): boolean {
  if (!task.notion_page_id) return false;
  if (task.source_of_change === 'notion') return false;
  if (!task.last_synced_at) return true;
  return isAfter(task.updated_at, task.last_synced_at);
}

async function runPush(ctx: SyncContext): Promise<void> {
  let tasks: TaskRecord[];
  try {
    tasks = await listTasksForSync(ctx.userId);
  } catch {
    ctx.summary.errors.push({
      scope: 'tasks',
      message: 'Could not load local tasks for the push phase.',
    });
    return;
  }

  const schemas = new Map<string, PropertyMapping | null>();

  for (const task of tasks) {
    if (!isPushCandidate(task)) continue;

    const databaseId = task.notion_database_id;
    const pageId = task.notion_page_id;
    if (!databaseId || !pageId) {
      // Nothing to push to; leave the row as-is.
      continue;
    }

    try {
      let mapping = schemas.get(databaseId);
      if (mapping === undefined) {
        try {
          const schema = await getDatabaseSchema(ctx.userId, databaseId);
          mapping = resolvePropertyMapping(schema);
        } catch (error) {
          schemas.set(databaseId, null);
          throw error;
        }
        schemas.set(databaseId, mapping);
      }
      if (!mapping) {
        throw new Error('Unmappable database.');
      }

      const properties = buildNotionProperties(mapping, task);
      await updatePage(ctx.userId, pageId, properties);
      await updateTaskRecord(ctx.userId, task.id, {
        sync_status: 'synced',
        last_synced_at: ctx.nowIso,
      });
      ctx.summary.pushed.updated += 1;
    } catch (error) {
      ctx.summary.pushed.failed += 1;
      ctx.summary.errors.push({
        scope: `task:${task.id}`,
        message: safeMessage(error, 'Could not push a task to Notion.'),
      });
      try {
        await updateTaskRecord(ctx.userId, task.id, { sync_status: 'error' });
      } catch {
        // Best-effort status write only.
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Top-level orchestration                                             */
/* ------------------------------------------------------------------ */

function emptySummary(direction: SyncDirection, startedAt: string): SyncSummary {
  return {
    direction,
    pulled: { created: 0, updated: 0, skipped: 0 },
    pushed: { updated: 0, failed: 0 },
    errors: [],
    startedAt,
    finishedAt: startedAt,
  };
}

/**
 * Reconciles one user's tasks with Notion. Never throws; returns a typed summary.
 */
export async function syncUser(
  userId: string,
  options: SyncUserOptions = {}
): Promise<SyncSummary> {
  const direction: SyncDirection = options.direction ?? 'both';
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const summary = emptySummary(direction, nowIso);

  try {
    const state = await getSyncState(userId);
    const ctx: SyncContext = {
      userId,
      watermark: state.lastSyncedAt ?? SYNC_EPOCH,
      nowIso,
      summary,
    };

    let pullFailed = false;

    if (direction === 'both' || direction === 'pull') {
      let mappings;
      try {
        mappings = await listMappings(userId);
      } catch {
        summary.errors.push({
          scope: 'databases',
          message: 'Could not load your Notion database mappings.',
        });
        mappings = null;
      }

      if (mappings) {
        for (const mapping of mappings) {
          const failed = await pullDatabase(mapping.notionDatabaseId, ctx);
          if (failed) pullFailed = true;
        }
      } else {
        pullFailed = true;
      }
    }

    if (direction === 'both' || direction === 'push') {
      await runPush(ctx);
    }

    summary.finishedAt = new Date().toISOString();

    const ranPull = direction === 'both' || direction === 'pull';
    const recentErrors = summary.errors.map((entry) => entry.message).slice(0, 10);

    await setSyncState(userId, {
      lastDirection: direction,
      lastError: recentErrors[0] ?? null,
      recentErrors,
      // Advance the watermark only on a clean pull pass, so a failed item is
      // retried on the next run rather than skipped forever.
      ...(ranPull && !pullFailed ? { lastSyncedAt: nowIso } : {}),
    });

    // Best-effort audit of the completed pass. Counts only — never task content,
    // Notion payloads, or tokens.
    audit(userId, 'sync_performed', {
      direction,
      pulled: summary.pulled,
      pushed: summary.pushed,
      errorCount: summary.errors.length,
    });

    return summary;
  } catch (error) {
    summary.finishedAt = new Date().toISOString();
    summary.errors.push({
      scope: 'sync',
      message: safeMessage(error, 'Sync could not complete.'),
    });
    return summary;
  }
}
