import type {
  NotionDatabaseSchema,
  NotionPropertySchema,
} from './schema';
import {
  getResolvedProperty,
  STATUS_OPTION_NAMES,
  PRIORITY_OPTION_NAMES,
} from './propertyMapping';
import type { PropertyMapping } from './propertyMapping';
import type { TaskPriority, TaskStatus } from '../tasks/repository';

/**
 * Phase 16 — reverse mapping: a Notion page → partial internal task fields.
 *
 * `mapNotionPageToTask` reads a raw Notion page's `properties` map using the
 * field → property-name `mapping` produced in Phase 9 (and the resolved property
 * metadata kept alongside it) and produces the subset of `assistant_tasks`
 * columns the sync engine writes.
 *
 * ## Never throws
 *
 * A missing/null property, an unexpected value shape, or a Notion option name we
 * do not recognise is handled gracefully: a sensible fallback is used and a
 * human-readable warning is collected. The sync engine logs those warnings; it
 * never aborts a pull because one property was surprising.
 *
 * ## Status / priority direction
 *
 * Outbound (Phase 9) maps internal values to friendly option names
 * (`in_progress` → `In progress`). Inbound this is reversed, case-insensitively,
 * and common synonyms are accepted (`Done`/`Complete` → `completed`,
 * `Todo`/`To do` → `not_started`, `Doing` → `in_progress`, …). Unknown status
 * option names fall back to `not_started`; unknown priorities become `null`.
 */

/** Minimal page shape the mapper needs (keeps the mapper pure and testable). */
export interface NotionPageLike {
  /** The page's `properties` object, keyed by property name. */
  properties: Record<string, unknown>;
  /** The public Notion URL, used when no `url` property is mapped. */
  url?: string | null;
}

/** The partial internal task fields derived from a Notion page. */
export interface NotionTaskFields {
  title?: string | null;
  description?: string | null;
  category?: string | null;
  priority?: TaskPriority | null;
  status?: TaskStatus;
  due_date?: string | null;
  due_time?: string | null;
  timezone?: string | null;
  notion_url?: string | null;
}

export interface NotionPageMapResult {
  fields: NotionTaskFields;
  /** Non-fatal issues encountered while mapping (safe, human-readable). */
  warnings: string[];
}

/** Reverse of the outbound status option names, plus common synonyms. */
const STATUS_FROM_OPTION: Record<string, TaskStatus> = {
  'not started': 'not_started',
  not_started: 'not_started',
  todo: 'not_started',
  'to do': 'not_started',
  backlog: 'not_started',
  open: 'not_started',
  'in progress': 'in_progress',
  in_progress: 'in_progress',
  doing: 'in_progress',
  blocked: 'blocked',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  done: 'completed',
  complete: 'completed',
  completed: 'completed',
  overdue: 'overdue',
};

/** Reverse of the outbound priority option names. */
const PRIORITY_FROM_OPTION: Record<string, TaskPriority> = {
  low: 'low',
  medium: 'medium',
  normal: 'medium',
  high: 'high',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Concatenates the `plain_text` of a Notion rich-text array (title/rich_text). */
function joinPlainText(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  const text = items
    .map((item) => {
      if (isObject(item) && typeof item.plain_text === 'string') return item.plain_text;
      return '';
    })
    .join('')
    .trim();
  return text.length > 0 ? text : null;
}

/** Reads the raw property value for a mapped field, or `undefined`. */
function readProperty(
  page: NotionPageLike,
  propertyName: string | undefined
): Record<string, unknown> | undefined {
  if (!propertyName) return undefined;
  const value = page.properties[propertyName];
  return isObject(value) ? value : undefined;
}

/** Case-insensitive lookup of an option name in a table. */
function lookup<T>(table: Record<string, T>, name: string): T | undefined {
  return table[name.trim().toLowerCase()];
}

/** Extracts a select/multi_select/status option name (first item for multi). */
function readOptionName(value: Record<string, unknown>): string | null {
  const select = value.select;
  if (isObject(select) && typeof select.name === 'string') return select.name;

  const status = value.status;
  if (isObject(status) && typeof status.name === 'string') return status.name;

  const multi = value.multi_select;
  if (Array.isArray(multi) && multi.length > 0) {
    const first = multi[0];
    if (isObject(first) && typeof first.name === 'string') return first.name;
  }

  return null;
}

/** Parses a Notion date value into `due_date` / `due_time` / `timezone`. */
function readDate(value: Record<string, unknown>): {
  due_date: string | null;
  due_time: string | null;
  timezone: string | null;
} {
  const date = value.date;
  if (!isObject(date) || typeof date.start !== 'string' || date.start.length === 0) {
    return { due_date: null, due_time: null, timezone: null };
  }

  const start = date.start;
  const timezone =
    typeof date.time_zone === 'string' && date.time_zone.length > 0 ? date.time_zone : null;

  if (start.includes('T')) {
    const [datePart, timePart = ''] = start.split('T');
    return {
      due_date: datePart || null,
      due_time: timePart.slice(0, 5) || null,
      timezone,
    };
  }

  return { due_date: start, due_time: null, timezone };
}

/**
 * Reads a mapped property and returns its resolved Notion type, so the mapper
 * knows how to interpret the value shape. Falls back to inferring the type from
 * the value itself when the schema metadata is unavailable.
 */
function resolvedType(
  schema: NotionDatabaseSchema,
  mapping: PropertyMapping,
  field: Parameters<typeof getResolvedProperty>[1]
): NotionPropertySchema | undefined {
  const fromMetadata = getResolvedProperty(mapping, field);
  if (fromMetadata) return fromMetadata;
  const name = mapping[field as keyof PropertyMapping] as string | undefined;
  if (!name) return undefined;
  return schema.properties.find((property) => property.name === name);
}

/**
 * Reverse-maps a Notion page into partial internal task fields.
 *
 * @param schema  The normalised database schema (used for property types).
 * @param mapping The resolved field → property-name mapping (Phase 9).
 * @param page    The raw page (only `properties` and `url` are read).
 */
export function mapNotionPageToTask(
  schema: NotionDatabaseSchema,
  mapping: PropertyMapping,
  page: NotionPageLike
): NotionPageMapResult {
  const fields: NotionTaskFields = {};
  const warnings: string[] = [];

  const propertyFor = (
    field: Parameters<typeof getResolvedProperty>[1]
  ): NotionPropertySchema | undefined => resolvedType(schema, mapping, field);

  /* ---------------------------------------------------------------- title */
  const titleValue = readProperty(page, mapping.title);
  const title = titleValue ? joinPlainText(titleValue.title) : null;
  if (title) {
    fields.title = title;
  } else if (mapping.title) {
    warnings.push(`Notion page ${mapping.title} has no title.`);
  }

  /* ---------------------------------------------------------- description */
  const descriptionProperty = propertyFor('description');
  const descriptionValue = readProperty(page, mapping.description);
  if (descriptionProperty && descriptionValue) {
    const text =
      descriptionProperty.type === 'title'
        ? joinPlainText(descriptionValue.title)
        : joinPlainText(descriptionValue.rich_text);
    fields.description = text;
  } else {
    fields.description = null;
  }

  /* --------------------------------------------------------------- status */
  const statusProperty = propertyFor('status');
  const statusValue = readProperty(page, mapping.status);
  let status: TaskStatus | undefined;
  if (statusProperty && statusValue) {
    if (statusProperty.type === 'checkbox') {
      status = statusValue.checkbox === true ? 'completed' : 'not_started';
    } else {
      const optionName = readOptionName(statusValue);
      if (optionName) {
        const mapped = lookup(STATUS_FROM_OPTION, optionName);
        if (mapped) {
          status = mapped;
        } else {
          warnings.push(`Unknown Notion status option "${optionName}" — using not_started.`);
          status = 'not_started';
        }
      }
    }
  }
  if (status) fields.status = status;

  /* ------------------------------------------------------------- priority */
  const priorityProperty = propertyFor('priority');
  const priorityValue = readProperty(page, mapping.priority);
  if (priorityProperty && priorityValue) {
    const optionName = readOptionName(priorityValue);
    if (optionName) {
      const mapped = lookup(PRIORITY_FROM_OPTION, optionName);
      if (mapped) {
        fields.priority = mapped;
      } else {
        warnings.push(`Unknown Notion priority option "${optionName}" — ignoring.`);
        fields.priority = null;
      }
    } else {
      fields.priority = null;
    }
  }

  /* ------------------------------------------------------------- category */
  const categoryProperty = propertyFor('category');
  const categoryValue = readProperty(page, mapping.category);
  if (categoryProperty && categoryValue) {
    const optionName = readOptionName(categoryValue);
    fields.category = optionName ?? null;
  }

  /* ----------------------------------------------------------------- date */
  const dateProperty = propertyFor('date');
  const dateValue = readProperty(page, mapping.date);
  if (dateProperty && dateValue) {
    const parsed = readDate(dateValue);
    fields.due_date = parsed.due_date;
    fields.due_time = parsed.due_time;
    fields.timezone = parsed.timezone;
  }

  /* ------------------------------------------------------------------ url */
  const urlValue = readProperty(page, mapping.url);
  const rawUrl = urlValue && typeof urlValue.url === 'string' ? urlValue.url : null;
  fields.notion_url = rawUrl ?? (typeof page.url === 'string' ? page.url : null);

  return { fields, warnings };
}

/**
 * Builds the option-name tables used for reverse mapping. Exported so the docs
 * and tests can assert the direction is the inverse of the outbound tables.
 */
export const REVERSE_STATUS_OPTIONS = STATUS_FROM_OPTION;
export const REVERSE_PRIORITY_OPTIONS = PRIORITY_FROM_OPTION;
/** Outbound names, re-exported for symmetry in tests/docs. */
export { STATUS_OPTION_NAMES, PRIORITY_OPTION_NAMES };
